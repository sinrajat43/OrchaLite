import { contextFor } from '../testing/task-context';
import { DelayTask } from './delay.task';
import { TransformTask } from './transform.task';

describe('transform', () => {
  it('returns its resolved value', async () => {
    expect(await new TransformTask().execute(contextFor({ value: { a: [1, 2] } }))).toEqual({ a: [1, 2] });
  });
});

describe('delay', () => {
  const task = new DelayTask();

  it('waits for the given time', async () => {
    const started = Date.now();
    expect(await task.execute(contextFor({ ms: 50 }))).toEqual({ waitedMs: 50 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('stops early when the step is aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = task.execute({ ...contextFor({ ms: 10_000 }), signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toThrow('Delay aborted');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
