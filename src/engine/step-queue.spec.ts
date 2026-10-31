import { startTestMongo } from '../testing/mongo';
import { InMemoryStepQueue } from './in-memory-step-queue';
import { MongoStepQueue } from './mongo-step-queue';
import { StepQueue } from './step-queue';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const job = (id: string) => ({ id, runId: 'r' });

// Every adapter must behave the same, so the engine can treat them as one thing
describe.each<[string, () => Promise<{ queue: StepQueue; stop: () => Promise<void> }>]>([
  ['in memory', async () => ({ queue: new InMemoryStepQueue(), stop: async () => undefined })],
  [
    'MongoDB',
    async () => {
      const mongo = await startTestMongo();
      return { queue: new MongoStepQueue(), stop: mongo.stop };
    },
  ],
])('StepQueue: %s', (_name, create) => {
  let queue: StepQueue;
  let stop: () => Promise<void>;
  let n = 0;
  const id = () => `job-${_name}-${n++}`;

  // Claims whatever is visible until nothing is, so each test starts empty
  const drain = async () => {
    for (let claim = await queue.claim('drain', 10_000); claim; claim = await queue.claim('drain', 10_000)) await queue.ack(claim);
  };

  beforeAll(async () => {
    ({ queue, stop } = await create());
  }, 60_000);
  afterAll(() => stop());
  beforeEach(drain);

  it('hands a job to one claimant at a time, oldest first', async () => {
    const [a, b] = [id(), id()];
    await queue.enqueue(job(a));
    await sleep(2);
    await queue.enqueue(job(b));

    const [first, second, third] = await Promise.all([queue.claim('w1', 5000), queue.claim('w2', 5000), queue.claim('w3', 5000)]);
    const claimed = [first, second, third].filter(Boolean).map(claim => claim.job.id);
    expect(claimed.sort()).toEqual([a, b].sort());
    expect((await queue.claim('w4', 5000))).toBeNull();
  });

  it('enqueues a job id once', async () => {
    const a = id();
    await Promise.all([queue.enqueue(job(a)), queue.enqueue(job(a)), queue.enqueue(job(a))]);

    expect((await queue.claim('w', 5000)).job.id).toBe(a);
    expect(await queue.claim('w', 5000)).toBeNull();
  });

  it('redelivers a job whose lease ran out, and the old holder can no longer touch it', async () => {
    const a = id();
    await queue.enqueue(job(a));
    const old = await queue.claim('dead', 30);
    await sleep(50);

    const next = await queue.claim('alive', 5000);
    expect(next.job.id).toBe(a);
    expect(await queue.extend(old, 5000)).toBe(false);
    await queue.ack(old);
    expect(await queue.extend(next, 5000)).toBe(true);
  });

  it('keeps a job invisible while its lease is renewed', async () => {
    await queue.enqueue(job(id()));
    const claim = await queue.claim('w', 60);
    await sleep(30);
    expect(await queue.extend(claim, 200)).toBe(true);
    await sleep(50);
    expect(await queue.claim('other', 5000)).toBeNull();
    await queue.ack(claim);
  });

  it('removes an acknowledged job', async () => {
    await queue.enqueue(job(id()));
    await queue.ack(await queue.claim('w', 10));
    await sleep(20);
    expect(await queue.claim('w', 5000)).toBeNull();
  });

  it('holds a delayed or released job until its time', async () => {
    const a = id();
    await queue.enqueue(job(a), new Date(Date.now() + 40));
    expect(await queue.claim('w', 5000)).toBeNull();
    await sleep(60);

    const claim = await queue.claim('w', 5000);
    expect(claim.job.id).toBe(a);
    await queue.release(claim, new Date(Date.now() + 40));
    expect(await queue.claim('w', 5000)).toBeNull();
    await sleep(60);
    expect((await queue.claim('w', 5000)).job.id).toBe(a);
  });
});
