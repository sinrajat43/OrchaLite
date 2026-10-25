import mongoose from 'mongoose';
import { validatorFor } from '../orchestrator/schema-validator';
import { contextFor } from '../testing/task-context';
import { startTestMongo } from '../testing/mongo';
import { MongoFindOneTask } from './mongo-find-one.task';
import { MongoUpsertTask } from './mongo-upsert.task';

describe('mongo.findOne and mongo.upsert', () => {
  const findOne = new MongoFindOneTask();
  const upsert = new MongoUpsertTask();
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ stop } = await startTestMongo());
  }, 60_000);

  afterAll(() => stop());

  it('creates, then updates, the document matching the filter', async () => {
    const write = (tag: string) =>
      upsert.execute(contextFor({ collection: 'releases', filter: { repo: 'a/b' }, set: { tag }, timestampField: 'seenAt' }));

    expect(await findOne.execute(contextFor({ collection: 'releases', filter: { repo: 'a/b' } }))).toBeNull();

    expect(await write('v1')).toEqual({ created: true, modified: false });
    expect(await findOne.execute(contextFor({ collection: 'releases', filter: { repo: 'a/b' } }))).toMatchObject({
      repo: 'a/b',
      tag: 'v1',
      seenAt: expect.any(Date),
    });

    expect(await write('v2')).toEqual({ created: false, modified: true });
    expect(await mongoose.connection.db.collection('releases').countDocuments()).toBe(1);
  });

  it('returns documents without the ObjectId, so outputs stay JSON', async () => {
    await upsert.execute(contextFor({ collection: 'plain', filter: { k: 1 }, set: { v: 2 } }));
    expect(await findOne.execute(contextFor({ collection: 'plain', filter: { k: 1 } }))).toEqual({ k: 1, v: 2 });
  });

  it('only accepts equality filters, so data cannot become a query operator', () => {
    const valid = validatorFor(findOne.paramsSchema);

    expect(valid({ collection: 'c', filter: { repo: 'a/b', n: 1, ok: true, gone: null } })).toBe(true);
    expect(valid({ collection: 'c', filter: { $where: 'sleep(1000)' } })).toBe(false);
    expect(valid({ collection: 'c', filter: { repo: { $ne: null } } })).toBe(false);
    expect(validatorFor(upsert.paramsSchema)({ collection: 'c', filter: {}, set: { $inc: 1 } })).toBe(false);
  });
});
