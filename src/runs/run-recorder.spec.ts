import { InMemoryRunStore } from './in-memory-run-store';
import { IllegalTransitionError, replay } from './run-projection';
import { appendRunEvent, capOutput, MAX_OUTPUT_BYTES, RunRecorder } from './run-recorder';
import { DuplicateEventError } from './run-store';
import { TaskExecutionError } from '../tasks/task.interface';
import { WorkflowDefinition } from '../orchestrator/workflow-definition';

const definition: WorkflowDefinition = {
  name: 'demo',
  input: { n: 'integer' },
  steps: [
    { id: 'a', task: 'one', dependsOn: [] },
    { id: 'b', task: 'two', dependsOn: ['a'] },
    { id: 'c', task: 'three', dependsOn: ['b'] },
  ],
};
const [a, b, c] = definition.steps;

describe('RunRecorder', () => {
  let store: InMemoryRunStore;
  let recorder: RunRecorder;

  beforeEach(() => {
    store = new InMemoryRunStore();
    recorder = new RunRecorder(store);
  });

  it('records nothing until the run starts', async () => {
    const run = recorder.prepare(definition);
    await run.fail(new Error('rejected'));
    await run.succeed();

    expect(run.started).toBe(false);
    expect(await store.getEvents(run.runId)).toEqual([]);
    expect(await store.getRun(run.runId)).toBeNull();
  });

  it('records a successful run as a timeline and a summary', async () => {
    const run = recorder.prepare(definition, { name: 'demo', version: 3 });
    await run.hooks.onRunStarted!({ n: 1 });
    await run.hooks.onStepStarted!(a);
    await run.hooks.onStepFinished!(a, { status: 'succeeded', output: 'A' });
    await run.hooks.onStepStarted!(b);
    await run.hooks.onStepFinished!(b, { status: 'succeeded', output: ['x', 'y'], iterations: 2 });
    await run.hooks.onStepStarted!(c);
    await run.hooks.onStepFinished!(c, { status: 'skipped', reason: 'when was false' });
    await run.succeed();

    const events = await store.getEvents(run.runId);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.map(e => e.type)).toEqual([
      'RunStarted',
      'StepStarted', 'StepSucceeded',
      'StepStarted', 'StepSucceeded',
      'StepStarted', 'StepSkipped',
      'RunSucceeded',
    ]);
    expect(events[2].data).toEqual({ stepId: 'a', output: 'A' });

    const summary = await store.getRun(run.runId);
    expect(summary).toMatchObject({
      name: 'demo',
      status: 'SUCCEEDED',
      input: { n: 1 },
      workflow: { name: 'demo', version: 3 },
      lastSeq: 8,
    });
    expect(summary!.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary!.steps).toMatchObject([
      { id: 'a', status: 'SUCCEEDED' },
      { id: 'b', status: 'SUCCEEDED', iterations: 2 },
      { id: 'c', status: 'SKIPPED', reason: 'when was false' },
    ]);
  });

  it('records the failed step and skips the steps after it', async () => {
    const run = recorder.prepare(definition);
    await run.hooks.onRunStarted!({});
    await run.hooks.onStepStarted!(a);
    await run.hooks.onStepFinished!(a, { status: 'succeeded', output: 1 });
    await run.hooks.onStepStarted!(b);
    const error = new TaskExecutionError('b', 'two', 'Task execution failed: kaput');
    await run.hooks.onStepFailed!(b, error);
    await run.fail(error);

    const summary = await store.getRun(run.runId);
    expect(summary).toMatchObject({ status: 'FAILED', failedStepId: 'b', error: 'Task execution failed: kaput' });
    expect(summary!.steps).toMatchObject([
      { id: 'a', status: 'SUCCEEDED' },
      { id: 'b', status: 'FAILED', error: 'Task execution failed: kaput' },
      { id: 'c', status: 'SKIPPED', reason: 'an earlier step failed' },
    ]);
  });

  it('keeps the summary equal to a replay of the events', async () => {
    const run = recorder.prepare(definition);
    await run.hooks.onRunStarted!({ n: 2 });
    await run.hooks.onStepStarted!(a);
    await run.hooks.onStepFinished!(a, { status: 'succeeded', output: [1, 2] });
    await run.fail(new Error('stopped'));

    expect(replay(await store.getEvents(run.runId))).toEqual(await store.getRun(run.runId));
  });

  it('does not throw when the store fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(store, 'appendEvent').mockRejectedValue(new Error('db down'));

    const run = recorder.prepare(definition);
    await expect(run.hooks.onRunStarted!({})).resolves.toBeUndefined();
    await expect(run.hooks.onStepStarted!(a)).resolves.toBeUndefined();
    await expect(run.succeed()).resolves.toBeUndefined();

    jest.restoreAllMocks();
  });

  it('marks runs left RUNNING by a dead process as ABANDONED', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = recorder.prepare(definition);
    await run.hooks.onRunStarted!({});
    await run.hooks.onStepStarted!(a);
    const finished = recorder.prepare(definition);
    await finished.hooks.onRunStarted!({});
    await finished.succeed();

    // A fresh recorder, as after a restart
    expect(await new RunRecorder(store).abandonUnfinishedRuns()).toEqual([run.runId]);

    const summary = await store.getRun(run.runId);
    expect(summary).toMatchObject({ status: 'ABANDONED', lastSeq: 3 });
    expect(summary!.steps[0].status).toBe('RUNNING');
    expect((await store.getEvents(run.runId)).map(e => e.type)).toEqual(['RunStarted', 'StepStarted', 'RunAbandoned']);
    expect((await store.getRun(finished.runId))!.status).toBe('SUCCEEDED');

    jest.restoreAllMocks();
  });

  it('lists runs newest first with filters and a cursor', async () => {
    const started = async (def: WorkflowDefinition) => {
      const run = recorder.prepare(def);
      await run.hooks.onRunStarted!({});
      return run;
    };
    const first = await started(definition);
    await first.succeed();
    const second = await started({ ...definition, name: 'other' });
    await second.fail(new Error('x'));
    const third = await started(definition);
    await third.succeed();

    const ids = (runs: { id: string }[]) => runs.map(r => r.id);
    expect(ids(await store.listRuns({ limit: 10 }))).toEqual([third.runId, second.runId, first.runId]);
    expect(ids(await store.listRuns({ limit: 10, status: 'FAILED' }))).toEqual([second.runId]);
    expect(ids(await store.listRuns({ limit: 10, name: 'demo' }))).toEqual([third.runId, first.runId]);
    expect(ids(await store.listRuns({ limit: 1, before: third.runId }))).toEqual([second.runId]);
  });
});

describe('appendRunEvent', () => {
  const started = { definition: { name: 'demo', steps: [{ id: 'a', task: 'one', dependsOn: [] }] }, input: {} };

  it('lets concurrent writers share a run, each event landing on its own seq', async () => {
    const store = new InMemoryRunStore();
    await appendRunEvent(store, 'r', 'RunStarted', started);

    await Promise.all(Array.from({ length: 5 }, (_, i) => appendRunEvent(store, 'r', 'StepRetryNoted' as any, { i })));

    expect((await store.getEvents('r')).map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await store.getRun('r'))!.lastSeq).toBeGreaterThan(1);
  });

  it('rejects a transition the state machine does not allow', async () => {
    const store = new InMemoryRunStore();
    await appendRunEvent(store, 'r', 'RunStarted', started);
    await appendRunEvent(store, 'r', 'RunSucceeded', {});

    await expect(appendRunEvent(store, 'r', 'RunFailed', { error: 'late' })).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(appendRunEvent(store, 'r', 'RunSucceeded', {})).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await store.getRun('r'))!.status).toBe('SUCCEEDED');
  });

  it('rejects a step transition that skips a state', async () => {
    const store = new InMemoryRunStore();
    await appendRunEvent(store, 'r', 'RunStarted', started);

    await expect(appendRunEvent(store, 'r', 'StepSucceeded', { stepId: 'a' })).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('catches up a summary left behind by a crash between the two writes', async () => {
    const store = new InMemoryRunStore();
    await appendRunEvent(store, 'r', 'RunStarted', started);
    // A process that died after writing the event, before the summary
    await store.appendEvent({ runId: 'r', seq: 2, type: 'StepStarted', at: new Date(), data: { stepId: 'a' } });

    const summary = await appendRunEvent(store, 'r', 'StepSucceeded', { stepId: 'a', output: 1 });

    expect(summary).toMatchObject({ lastSeq: 3, steps: [{ id: 'a', status: 'SUCCEEDED' }] });
    // The version check keeps the stale summary from being overwritten by a writer that read seq 2
    expect((await store.getRun('r'))!.lastSeq).toBe(3);
    expect(await store.saveSummary({ ...summary, lastSeq: 4 }, 2)).toBe(false);
  });
});

describe('InMemoryRunStore', () => {
  it('rejects a second event with the same seq', async () => {
    const store = new InMemoryRunStore();
    const event = { runId: 'r', seq: 1, type: 'RunStarted' as const, at: new Date(), data: {} };
    await store.appendEvent(event);
    await expect(store.appendEvent(event)).rejects.toBeInstanceOf(DuplicateEventError);
  });
});

describe('capOutput', () => {
  it('keeps small outputs as they are', () => {
    expect(capOutput([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(capOutput(undefined)).toBeUndefined();
  });

  it('replaces outputs over the cap with a preview', () => {
    const big = 'x'.repeat(MAX_OUTPUT_BYTES + 1);
    expect(capOutput(big)).toEqual({ truncated: true, sizeBytes: MAX_OUTPUT_BYTES + 3, preview: expect.any(String) });
    expect(capOutput(big).preview.length).toBe(2000);
  });
});
