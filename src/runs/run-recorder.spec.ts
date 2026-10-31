import { InMemoryRunStore } from './in-memory-run-store';
import { IllegalTransitionError, replay } from './run-projection';
import { appendRunEvent, capOutput, MAX_OUTPUT_BYTES } from './run-recorder';
import { DuplicateEventError } from './run-store';

describe('InMemoryRunStore listing', () => {
  it('lists runs newest first with filters and a cursor', async () => {
    const store = new InMemoryRunStore();
    const definition = { name: 'demo', steps: [{ id: 'a', task: 'one', dependsOn: [] }] };
    const started = async (id: string, def: object) => appendRunEvent(store, id, 'RunStarted', { definition: def, input: {} });
    await started('1', definition);
    await appendRunEvent(store, '1', 'RunSucceeded', {});
    await started('2', { ...definition, name: 'other' });
    await appendRunEvent(store, '2', 'RunFailed', { error: 'x' });
    await started('3', definition);
    await appendRunEvent(store, '3', 'RunSucceeded', {});

    const ids = (runs: { id: string }[]) => runs.map(r => r.id);
    expect(ids(await store.listRuns({ limit: 10 }))).toEqual(['3', '2', '1']);
    expect(ids(await store.listRuns({ limit: 10, status: 'FAILED' }))).toEqual(['2']);
    expect(ids(await store.listRuns({ limit: 10, name: 'demo' }))).toEqual(['3', '1']);
    expect(ids(await store.listRuns({ limit: 1, before: '3' }))).toEqual(['2']);
  });

  it('keeps the summary equal to a replay of the events', async () => {
    const store = new InMemoryRunStore();
    await appendRunEvent(store, 'r', 'RunStarted', { definition: { name: 'demo', steps: [{ id: 'a', task: 'one', dependsOn: [] }] }, input: { n: 2 } });
    await appendRunEvent(store, 'r', 'StepStarted', { stepId: 'a' });
    await appendRunEvent(store, 'r', 'StepSucceeded', { stepId: 'a', output: [1, 2] });
    await appendRunEvent(store, 'r', 'RunFailed', { error: 'stopped' });

    expect(replay(await store.getEvents('r'))).toEqual(await store.getRun('r'));
  });
});

describe('appendRunEvent', () => {
  const started = { definition: { name: 'demo', steps: [{ id: 'a', task: 'one', dependsOn: [] }] }, input: {} };

  it('lets concurrent writers share a run, each event landing on its own seq', async () => {
    const store = new InMemoryRunStore();
    await appendRunEvent(store, 'r', 'RunStarted', started);

    await Promise.all(Array.from({ length: 5 }, (_, i) => appendRunEvent(store, 'r', 'StepRetryScheduled', { stepId: 'a', i })));

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
