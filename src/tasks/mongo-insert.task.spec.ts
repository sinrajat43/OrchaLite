import mongoose from 'mongoose';
import { contextFor } from '../testing/task-context';
import { startTestMongo } from '../testing/mongo';
import { MongoInsertTask } from './mongo-insert.task';

describe('mongo.insert', () => {
  const task = new MongoInsertTask();
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ stop } = await startTestMongo());
  }, 60_000);

  afterAll(() => stop());

  const collection = (name: string) => mongoose.connection.db.collection(name);

  it('inserts one document or many, leaving the params untouched', async () => {
    const documents = [{ name: 'a' }, { name: 'b' }];

    expect(await task.execute(contextFor({ collection: 'many', documents }))).toEqual({ insertedCount: 2 });
    expect(await task.execute(contextFor({ collection: 'one', documents: { name: 'c' } }))).toEqual({ insertedCount: 1 });

    expect(await collection('many').find({}, { projection: { _id: 0 } }).toArray()).toEqual(documents);
    expect(await collection('one').countDocuments()).toBe(1);
    expect(documents[0]).not.toHaveProperty('_id');
  });

  it('stamps each document with the insert time as a Date when asked', async () => {
    await task.execute(contextFor({ collection: 'stamped', documents: [{ n: 1 }, { n: 2 }], timestampField: 'insertedAt' }));

    const stored = await collection('stamped').find().toArray();
    expect(stored).toHaveLength(2);
    expect(stored[0].insertedAt).toBeInstanceOf(Date);
    expect(stored[0].insertedAt).toEqual(stored[1].insertedAt);
  });

  it('inserts nothing twice when a step repeats, even if the first try was cut short', async () => {
    const first = [{ n: 1 }];
    await task.execute({ ...contextFor({ collection: 'repeat', documents: first }), idempotencyKey: 'run:step' });

    const output = await task.execute({ ...contextFor({ collection: 'repeat', documents: [{ n: 1 }, { n: 2 }] }), idempotencyKey: 'run:step' });

    expect(output).toEqual({ insertedCount: 2 });
    expect((await collection('repeat').find({}, { projection: { n: 1 } }).sort({ n: 1 }).toArray()).map(d => d.n)).toEqual([1, 2]);
  });

  it('still fails on a clash with an _id the definition chose', async () => {
    await task.execute(contextFor({ collection: 'chosen', documents: { _id: 'x', n: 1 } }));

    await expect(task.execute({ ...contextFor({ collection: 'chosen', documents: { _id: 'x', n: 2 } }), idempotencyKey: 'other' })).rejects.toThrow('duplicate key');
  });
});
