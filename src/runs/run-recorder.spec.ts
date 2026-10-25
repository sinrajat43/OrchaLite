import { InMemoryRunStore } from './in-memory-run-store';
import { replay } from './run-projection';
import { capOutput, MAX_OUTPUT_BYTES, RunRecorder } from './run-recorder';
import { DuplicateEventError } from './run-store';
import { TaskExecutionError } from '../tasks/task.interface';

const definition = {
  name: 'demo',
  steps: [
    { id: 'a', task: 'one', dependsOn: [] },
    { id: 'b', task: 'two', dependsOn: ['a'] },
    { id: 'c', task: 'three', dependsOn: ['b'] },
  ],
};
const [a, b] = definition.steps;

describe('RunRecorder', () => {
  let store: InMemoryRunStore;
  let recorder: RunRecorder;

  beforeEach(() => {
    store = new InMemoryRunStore();
    recorder = new RunRecorder(store);
  });

  it('records a successful run as a timeline and a summary', async () => {
    const run = await recorder.start(definition);
    for (const s of definition.steps) {
      await run.hooks.onStepStarted!(s);
      await run.hooks.onStepSucceeded!(s, s.id.toUpperCase());
    }
    await run.succeed();

    const events = await store.getEvents(run.runId);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.map(e => e.type)).toEqual([
      'RunStarted',
      'StepStarted', 'StepSucceeded',
      'StepStarted', 'StepSucceeded',
      'StepStarted', 'StepSucceeded',
      'RunSucceeded',
    ]);
    expect(events[2].data).toEqual({ stepId: 'a', output: 'A' });

    const summary = await store.getRun(run.runId);
    expect(summary).toMatchObject({ name: 'demo', status: 'SUCCEEDED', lastSeq: 8 });
    expect(summary!.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary!.steps.map(s => s.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  });

  it('records the failed step and skips the steps after it', async () => {
    const run = await recorder.start(definition);
    await run.hooks.onStepStarted!(a);
    await run.hooks.onStepSucceeded!(a, 1);
    await run.hooks.onStepStarted!(b);
    const error = new TaskExecutionError('b', 'two', 'Task execution failed: kaput');
    await run.hooks.onStepFailed!(b, error);
    await run.fail(error);

    const summary = await store.getRun(run.runId);
    expect(summary).toMatchObject({ status: 'FAILED', failedStepId: 'b', error: 'Task execution failed: kaput' });
    expect(summary!.steps).toMatchObject([
      { id: 'a', status: 'SUCCEEDED' },
      { id: 'b', status: 'FAILED', error: 'Task execution failed: kaput' },
      { id: 'c', status: 'SKIPPED' },
    ]);
  });

  it('keeps the summary equal to a replay of the events', async () => {
    const run = await recorder.start(definition);
    await run.hooks.onStepStarted!(a);
    await run.hooks.onStepSucceeded!(a, [1, 2]);
    await run.fail(new Error('stopped'));

    expect(replay(await store.getEvents(run.runId))).toEqual(await store.getRun(run.runId));
  });

  it('does not throw when the store fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(store, 'appendEvent').mockRejectedValue(new Error('db down'));

    const run = await recorder.start(definition);
    await expect(run.hooks.onStepStarted!(a)).resolves.toBeUndefined();
    await expect(run.succeed()).resolves.toBeUndefined();

    jest.restoreAllMocks();
  });

  it('marks runs left RUNNING by a dead process as ABANDONED', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = await recorder.start(definition);
    await run.hooks.onStepStarted!(a);
    const finished = await recorder.start(definition);
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
    const first = await recorder.start(definition);
    await first.succeed();
    const second = await recorder.start({ ...definition, name: 'other' });
    await second.fail(new Error('x'));
    const third = await recorder.start(definition);
    await third.succeed();

    const ids = (runs: { id: string }[]) => runs.map(r => r.id);
    expect(ids(await store.listRuns({ limit: 10 }))).toEqual([third.runId, second.runId, first.runId]);
    expect(ids(await store.listRuns({ limit: 10, status: 'FAILED' }))).toEqual([second.runId]);
    expect(ids(await store.listRuns({ limit: 10, name: 'demo' }))).toEqual([third.runId, first.runId]);
    expect(ids(await store.listRuns({ limit: 1, before: third.runId }))).toEqual([second.runId]);
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
