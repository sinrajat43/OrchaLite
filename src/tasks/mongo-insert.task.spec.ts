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
});
