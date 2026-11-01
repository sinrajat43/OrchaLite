import { Logger } from '@nestjs/common';
import { WorkflowDefinition, WorkflowStep } from '../orchestrator/workflow-definition';
import { InMemoryRunStore } from '../runs/in-memory-run-store';
import { Task, TaskExecutionError, SuspendTask } from '../tasks/task.interface';
import { runWorkflow } from '../testing/run-workflow';
import { fakeTask, silentLogger } from '../testing/task-context';
import { until } from '../testing/wait';
import { EngineSignals } from './engine-signals';
import { InMemoryStepQueue } from './in-memory-step-queue';
import { InMemoryRateLimiter } from './rate-limiter';
import { Worker } from './worker';

const definition = (step: Partial<WorkflowStep> = {}): WorkflowDefinition => ({ name: 'test', steps: [{ id: 'a', task: 't', dependsOn: [], ...step }] });

// Waits for the worker to abort it, as a task honouring its signal does
const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

describe('Worker', () => {
  let store: InMemoryRunStore;
  let queue: InMemoryStepQueue;
  let worker: Worker;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  // One step, queued and ready, as the scheduler would leave it
  const seed = async (def = definition(), task = 't') => {
    await store.saveSummary({ id: 'r', name: 'test', status: 'RUNNING', startedAt: new Date(), definition: def, steps: [], lastSeq: 1, execution: 'queue' }, 0);
    await store.insertStepRuns([{ id: 'r:a', runId: 'r', stepId: 'a', task, status: 'QUEUED', version: 1, fence: 0 }]);
    await queue.enqueue({ id: 'r:a', runId: 'r' });
  };

  const start = (task: Task, options: { leaseMs?: number; shutdownGraceMs?: number } = {}) => {
    worker = new Worker({
      store,
      queue,
      tasks: new Map([['t', task]]),
      signals: new EngineSignals(),
      connections: { get: async () => null },
      limiter: new InMemoryRateLimiter(),
      createLogger: () => silentLogger,
      options: { leaseMs: 60_000, workerSlots: 1, workerPollMs: 2, defaultStepTimeoutMs: 60_000, maxLostDeliveries: 5, shutdownGraceMs: 50, ...options },
    });
    worker.start();
  };

  const row = (status: string) => until(() => store.getStepRun('r:a'), current => current.status === status, `the step to be ${status}`);

  beforeEach(() => {
    store = new InMemoryRunStore();
    queue = new InMemoryStepQueue();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    jest.restoreAllMocks();
  });

  it('aborts a task whose lease is lost, leaving the job for the next delivery', async () => {
    await seed();
    jest.spyOn(queue, 'extend').mockResolvedValueOnce(false);
    const signals: AbortSignal[] = [];
    start(
      fakeTask(async ({ signal }) => {
        signals.push(signal);
        if (signals.length === 1) return untilAborted(signal);
        return 'second';
      }),
      { leaseMs: 60 }
    );

    expect(await row('SUCCEEDED')).toMatchObject({ output: 'second', fence: 2 });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lease lost'));
  });

  it('keeps working when renewing a lease fails once, as with a database blip', async () => {
    await seed();
    const extend = jest.spyOn(queue, 'extend').mockRejectedValueOnce(new Error('database blip'));
    start(
      fakeTask(async () => {
        await until(async () => extend.mock.calls.length, calls => calls >= 2, 'a second renewal');
        return 'done';
      }),
      { leaseMs: 30 }
    );

    expect(await row('SUCCEEDED')).toMatchObject({ output: 'done', fence: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not renew r:a: database blip'));
  });

  it('hands a step straight back when draining outlasts the grace period', async () => {
    await seed();
    let started: () => void;
    const hasStarted = new Promise<void>(resolve => (started = resolve));
    let seen: AbortSignal;
    start(
      fakeTask(async ({ signal }) => {
        seen = signal;
        started();
        return untilAborted(signal);
      }),
      { shutdownGraceMs: 5 }
    );
    await hasStarted;

    await worker.stop();

    expect(seen.aborted).toBe(true);
    // Not a failure and not a lost delivery, and the next worker need not wait out a lease
    const stopped = await store.getStepRun('r:a');
    expect(stopped).toMatchObject({ status: 'QUEUED', yields: 1 });
    expect(stopped.failures ?? []).toEqual([]);
    expect((await queue.claim('next', 1000)).job.id).toBe('r:a');
  });

  it('carries on after failing to claim, as with a database blip', async () => {
    await seed();
    jest.spyOn(queue, 'claim').mockRejectedValueOnce(new Error('database down'));
    start(fakeTask(async () => 'done'));

    expect(await row('SUCCEEDED')).toMatchObject({ output: 'done' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('database down'));
  });

  it('fails a step whose task this worker does not have', async () => {
    await seed(definition(), 'gone');
    start(fakeTask(async () => 'never'));

    expect(await row('FAILED')).toMatchObject({ error: expect.stringContaining('no task "gone"') });
  });

  it('fails a step whose stored definition no longer compiles', async () => {
    await seed(definition({ task: 'removed' }));
    start(fakeTask(async () => 'never'));

    expect(await row('FAILED')).toMatchObject({ error: expect.stringContaining('Invalid workflow definition') });
  });

  it('fails a step whose run no longer exists', async () => {
    await seed();
    jest.spyOn(store, 'getRun').mockResolvedValue(null);
    start(fakeTask(async () => 'never'));

    expect(await row('FAILED')).toMatchObject({ error: 'Run r no longer exists' });
  });

  it('leaves the job for its lease to run out when the database fails mid-step', async () => {
    await seed();
    const read = jest.spyOn(store, 'getRun').mockRejectedValueOnce(new Error('database down'));
    start(fakeTask(async () => 'done'), { leaseMs: 60 });

    expect(await row('SUCCEEDED')).toMatchObject({ output: 'done' });
    expect(read).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('database down'));
  });

  it('still retries when the retry cannot be recorded, since the row holds the truth', async () => {
    await seed(definition({ retry: { maxAttempts: 2, backoffMs: 1 } }));
    jest.spyOn(store, 'appendEvent').mockRejectedValueOnce(new Error('database blip'));
    let attempts = 0;
    start(
      fakeTask(async () => {
        if (++attempts === 1) throw new Error('first try fails');
        return 'done';
      })
    );

    expect(await row('SUCCEEDED')).toMatchObject({ output: 'done' });
    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record a retry of r:a'));
  });

  it('schedules no retry for a worker that a newer one has replaced', async () => {
    await seed(definition({ retry: { maxAttempts: 3 } }));
    let started: () => void;
    const hasStarted = new Promise<void>(resolve => (started = resolve));
    let fail: (reason: Error) => void;
    const release = jest.spyOn(queue, 'release');
    start(
      fakeTask(async () => {
        started();
        return new Promise((_, reject) => (fail = reject));
      })
    );
    await hasStarted;

    const replaced = await store.updateStepRun('r:a', {}, { status: 'RUNNING' }, { takeFence: true });
    await store.updateStepRun('r:a', { fence: replaced.fence }, { status: 'SUCCEEDED', output: 'fresh' });
    fail(new Error('stale failure'));
    await worker.stop();

    const finished = await store.getStepRun('r:a');
    expect(finished).toMatchObject({ status: 'SUCCEEDED', output: 'fresh' });
    expect(finished.failures ?? []).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect((await store.getEvents('r')).map(event => event.type)).not.toContain('StepRetryScheduled');
  });
});

describe('Worker, on the real scheduler', () => {
  it('runs a suspended task again after its wait, without using up an attempt', async () => {
    const store = new InMemoryRunStore();
    const resumes: boolean[] = [];
    const task = fakeTask(async ({ resumed, attempt }) => {
      resumes.push(Boolean(resumed));
      if (!resumed) throw new SuspendTask(5);
      return { attempt };
    });

    const result = await runWorkflow(definition(), new Map([['t', task]]), { store, runId: 'r' });

    expect(resumes).toEqual([false, true]);
    expect(result.steps.a.output).toEqual({ attempt: 1 });
    const finished = await store.getStepRun('r:a');
    expect(finished).toMatchObject({ status: 'SUCCEEDED', yields: 1, resumed: true });
    expect(finished.failures ?? []).toEqual([]);
  });

  it('fails a step whose output is too large to store', async () => {
    const task = fakeTask(async () => 'x'.repeat(9 * 1024 * 1024));

    const run = runWorkflow(definition(), new Map([['t', task]]));

    await expect(run).rejects.toBeInstanceOf(TaskExecutionError);
    await expect(run).rejects.toThrow(/byte limit/);
  });
});
