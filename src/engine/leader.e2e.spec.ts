import mongoose from 'mongoose';
import { startTestApi, TestApi } from '../testing/api-app';
import { buildEngine, EngineProcess, startEngineProcess } from '../testing/engine-process';
import { until } from '../testing/wait';
import { MongoLeaderLock } from './leader-lock';

// Real scheduler processes competing for the lock, one of them really killed
describe('scheduler failover', () => {
  let api: TestApi;
  const processes: EngineProcess[] = [];

  const scheduler = () => {
    const started = startEngineProcess({
      MONGODB_URI: api.mongoUri,
      ORCHALITE_ROLES: 'scheduler',
      ORCHALITE_LEADER_TTL_MS: '1000',
      ORCHALITE_SCHEDULER_INTERVAL_MS: '50',
    });
    processes.push(started);
    return started;
  };
  const holder = async (): Promise<any> => mongoose.connection.db.collection('engine_locks').findOne({ _id: 'scheduler' as any });
  const runs = async () => (await api.request('GET', '/runs?name=beat&limit=100')).body as any[];

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    buildEngine('leader');
    process.env.ORCHALITE_ROLES = 'api,worker';
    process.env.ORCHALITE_WORKER_POLL_MS = '20';
    api = await startTestApi();
  }, 120_000);

  afterAll(async () => {
    delete process.env.ORCHALITE_ROLES;
    delete process.env.ORCHALITE_WORKER_POLL_MS;
    await Promise.all(processes.map(p => p.kill()));
    await api.close();
    jest.restoreAllMocks();
  });

  it('gives the lock to one owner at a time, and to another once it expires', async () => {
    const lock = new MongoLeaderLock();
    const results = await Promise.all(['a', 'b', 'c', 'd'].map(owner => lock.acquire('test', owner, 100)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = ['a', 'b', 'c', 'd'][results.indexOf(true)];

    expect(await lock.acquire('test', winner, 100)).toBe(true);
    expect(await lock.acquire('test', 'other', 100)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(await lock.acquire('test', 'other', 100)).toBe(true);
    await lock.release('test', 'other');
    expect(await lock.acquire('test', 'third', 100)).toBe(true);
  });

  it('fires cron once per second with two schedulers, and carries on when the leader is killed', async () => {
    await api.request('POST', '/workflows', { name: 'beat', steps: [{ id: 'a', task: 'transform', params: { value: 1 }, dependsOn: [] }] });
    const [first, second] = [scheduler(), scheduler()];
    await until(holder, lock => !!lock?.owner, 'a leader');

    const created = await api.request('PUT', '/triggers/beat', { type: 'cron', workflow: 'beat', cron: '* * * * * *' });
    expect(created.status).toBe(200);

    const before = await until(runs, list => list.length >= 3, 'firings under the first leader');
    // Two schedulers firing would show up as more than one run per scheduled second
    const events = await Promise.all(
      before.map(run => mongoose.connection.db.collection('run_requests').findOne({ runId: run.id }))
    );
    const keys = events.map((request: any) => request._id);
    expect(new Set(keys).size).toBe(keys.length);

    const leaderPid = Number((await holder()).owner.split(':')[1]);
    const [leader] = [first, second].filter(p => p.child.pid === leaderPid);
    expect(leader).toBeDefined();
    await leader.kill();
    const countAtKill = (await runs()).length;

    await until(holder, lock => Number(lock?.owner.split(':')[1]) !== leaderPid, 'a new leader', 10_000);
    const after = await until(runs, list => list.length >= countAtKill + 2, 'firings under the new leader', 15_000);

    expect(after.every(run => ['RUNNING', 'SUCCEEDED'].includes(run.status))).toBe(true);
    const finished = await until(runs, list => list.slice(2).every(run => run.status === 'SUCCEEDED'), 'runs to finish', 10_000);
    expect(finished.length).toBeGreaterThan(countAtKill);
  }, 60_000);
});
