import IORedis from 'ioredis';
import { ServerResponse } from 'http';
import { startTestApi, TestApi } from '../testing/api-app';
import { buildEngine, EngineProcess, startEngineProcess } from '../testing/engine-process';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { redisAvailable, startTestRedis } from '../testing/redis';
import { until } from '../testing/wait';

// The whole engine on the other queue, in real processes
(redisAvailable() ? describe : describe.skip)('the engine on BullMQ', () => {
  let api: TestApi;
  let upstream: TestServer;
  let redis: { url: string; stop: () => Promise<void> };
  const processes: EngineProcess[] = [];
  const held: ServerResponse[] = [];
  let hang = true;

  const worker = () => {
    const started = startEngineProcess({
      MONGODB_URI: api.mongoUri,
      REDIS_URL: redis.url,
      ORCHALITE_QUEUE: 'bullmq',
      ORCHALITE_ROLES: 'worker',
      ORCHALITE_LEASE_MS: '3000',
      ORCHALITE_STALLED_INTERVAL_MS: '200',
      ORCHALITE_WORKER_POLL_MS: '50',
    });
    processes.push(started);
    return started;
  };
  const result = (runId: string) => api.request('GET', `/runs/${runId}/result`).then(r => r.body);
  const finished = (runId: string) => until(() => result(runId), body => !['RUNNING', 'COMPENSATING'].includes(body.status), `run ${runId}`, 60_000);
  const step = (id: string, value: unknown, dependsOn: string[] = []) => ({ id, task: 'transform', params: { value }, dependsOn });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    buildEngine('bullmq');
    redis = await startTestRedis();
    upstream = await startTestServer((req, res) => {
      if (req.url === '/hang' && hang) return void held.push(res);
      sendJson(res, 200, { ok: true });
    });
    Object.assign(process.env, { ORCHALITE_QUEUE: 'bullmq', REDIS_URL: redis.url, ORCHALITE_ROLES: 'api,scheduler', ORCHALITE_SCHEDULER_INTERVAL_MS: '50', ORCHALITE_QUEUE_RESTORE_MS: '500' });
    api = await startTestApi();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(processes.map(p => p.kill()));
    held.forEach(res => res.destroy());
    await api.close();
    await upstream.close();
    await redis.stop();
    for (const name of ['ORCHALITE_QUEUE', 'REDIS_URL', 'ORCHALITE_ROLES', 'ORCHALITE_SCHEDULER_INTERVAL_MS', 'ORCHALITE_QUEUE_RESTORE_MS']) delete process.env[name];
    jest.restoreAllMocks();
  });

  it('runs a workflow with a fan-out, a retry and a stored wait', async () => {
    worker();
    const definition = {
      name: 'bullmq-demo',
      steps: [
        { id: 'each', task: 'transform', forEach: '{{ [1, 2, 3, 4, 5] }}', concurrency: 2, params: { value: '{{ item * 2 }}' }, dependsOn: [] },
        { id: 'wait', task: 'delay', params: { ms: 300 }, dependsOn: ['each'] },
        step('last', '{{ steps.each.output }}', ['wait']),
      ],
    };

    const { runId } = (await api.request('POST', '/workflow/run', { definition })).body;
    const run = await finished(runId);

    expect(run).toMatchObject({ status: 'SUCCEEDED', steps: { last: { output: [2, 4, 6, 8, 10] }, wait: { output: { waitedMs: 300 } } } });
  }, 90_000);

  it('finishes a step on another worker after one is killed holding it', async () => {
    const definition = { name: 'bullmq-crash', steps: [{ id: 'call', task: 'http.request', params: { url: `${upstream.url}/hang` }, dependsOn: [] }] };
    await Promise.all(processes.splice(0).map(p => p.kill()));
    upstream.requests.length = 0;
    hang = true;
    const victim = worker();

    const { runId } = (await api.request('POST', '/workflow/run', { definition })).body;
    await until(async () => upstream.requests.length, count => count === 1, 'the first worker to reach the step', 60_000);
    hang = false;
    await victim.kill();
    worker();

    expect(await finished(runId)).toMatchObject({ status: 'SUCCEEDED', steps: { call: { output: { status: 200 } } } });
    expect(upstream.requests).toHaveLength(2);
  }, 120_000);

  it('recovers when Redis loses every job, because the rows are the truth', async () => {
    await Promise.all(processes.splice(0).map(p => p.kill()));
    const definition = { name: 'bullmq-flush', steps: [step('a', 1), step('b', '{{ steps.a.output + 1 }}', ['a'])] };

    // No worker yet, so the job is sitting in Redis when Redis loses it
    const { runId } = (await api.request('POST', '/workflow/run', { definition })).body;
    const client = new IORedis(redis.url);
    await until(() => client.llen('bull:orchalite-steps:wait'), length => length === 1, 'the job to reach Redis');
    await client.flushall();
    await client.quit();

    worker();

    expect(await finished(runId)).toMatchObject({ status: 'SUCCEEDED', steps: { b: { output: 2 } } });
  }, 120_000);
});
