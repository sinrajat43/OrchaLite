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

  it('asks to be suspended rather than holding a worker', async () => {
    await expect(task.execute(contextFor({ ms: 50 }))).rejects.toMatchObject({ name: 'SuspendTask', ms: 50 });
  });

  it('finishes when resumed', async () => {
    expect(await task.execute({ ...contextFor({ ms: 50 }), resumed: true })).toEqual({ waitedMs: 50 });
  });
});
