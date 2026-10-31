import { ServerResponse } from 'http';
import { startTestApi, TestApi } from '../testing/api-app';
import { buildEngine, EngineProcess, startEngineProcess } from '../testing/engine-process';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { until } from '../testing/wait';

// Real processes and a real SIGKILL: the worker gets no chance to clean up
describe('worker crash', () => {
  let api: TestApi;
  let upstream: TestServer;
  const processes: EngineProcess[] = [];
  const held: ServerResponse[] = [];
  let hang = true;

  const worker = () => {
    const started = startEngineProcess({ MONGODB_URI: api.mongoUri, ORCHALITE_ROLES: 'worker', ORCHALITE_LEASE_MS: '1000', ORCHALITE_WORKER_POLL_MS: '50' });
    processes.push(started);
    return started;
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    buildEngine();

    upstream = await startTestServer((_req, res) => {
      // The first call never answers, so the first worker is mid-step when it is killed
      if (hang) held.push(res);
      else sendJson(res, 200, { ok: true });
    });
    process.env.ORCHALITE_ROLES = 'api,scheduler';
    process.env.ORCHALITE_SCHEDULER_INTERVAL_MS = '50';
    api = await startTestApi();
  }, 120_000);

  afterAll(async () => {
    delete process.env.ORCHALITE_ROLES;
    delete process.env.ORCHALITE_SCHEDULER_INTERVAL_MS;
    await Promise.all(processes.map(p => p.kill()));
    held.forEach(res => res.destroy());
    await api.close();
    await upstream.close();
    jest.restoreAllMocks();
  });

  it('finishes a run on another worker after one is killed mid-step', async () => {
    const definition = {
      name: 'crash-demo',
      steps: [
        { id: 'first', task: 'transform', params: { value: 'kept' }, dependsOn: [] },
        { id: 'call', task: 'http.request', params: { url: `${upstream.url}/slow` }, dependsOn: ['first'] },
        { id: 'last', task: 'transform', params: { value: '{{ steps.first.output }}' }, dependsOn: ['call'] },
      ],
    };

    const victim = worker();
    const accepted = await api.request('POST', '/workflow/run', { definition });
    expect(accepted.status).toBe(202);
    const { runId } = accepted.body;

    await until(async () => upstream.requests.length, count => count === 1, 'the first worker to reach the slow step');
    const during = await api.request('GET', `/runs/${runId}/result`);
    expect(during.body.status).toBe('RUNNING');
    expect(during.body.steps.first.status).toBe('succeeded');

    hang = false;
    await victim.kill();
    const killedAt = Date.now();

    worker();
    const result = await until(
      async () => (await api.request('GET', `/runs/${runId}/result`)).body,
      body => body.status !== 'RUNNING',
      'the run to finish on the second worker'
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(result.steps.call.output.status).toBe(200);
    expect(result.steps.last.output).toBe('kept');
    expect(upstream.requests).toHaveLength(2);
    // It waited for the dead worker's lease to run out, rather than starting at once
    expect(Date.now() - killedAt).toBeGreaterThan(300);

    const events = (await api.request('GET', `/runs/${runId}/events`)).body.map((e: any) => [e.type, e.data.stepId].filter(Boolean).join(' '));
    expect(events).toEqual([
      'RunStarted',
      'StepStarted first', 'StepSucceeded first',
      'StepStarted call', 'StepSucceeded call',
      'StepStarted last', 'StepSucceeded last',
      'RunSucceeded',
    ]);
  }, 60_000);

  it('holds a durable delay through a worker restart, using no worker while it waits', async () => {
    const definition = {
      name: 'delay-demo',
      steps: [
        { id: 'wait', task: 'delay', params: { ms: 1500 }, dependsOn: [] },
        { id: 'after', task: 'transform', params: { value: '{{ steps.wait.output.waitedMs }}' }, dependsOn: ['wait'] },
      ],
    };
    processes.splice(0).forEach(p => p.kill());
    const first = worker();
    const { runId } = (await api.request('POST', '/workflow/run', { definition })).body;
    const started = Date.now();

    await until(
      async () => (await api.request('GET', `/runs/${runId}/result`)).body,
      body => body.steps.wait.status === 'running',
      'the delay to start'
    );
    await new Promise(resolve => setTimeout(resolve, 200));
    await first.kill();
    worker();

    const result = await until(
      async () => (await api.request('GET', `/runs/${runId}/result`)).body,
      body => body.status !== 'RUNNING',
      'the run to finish after the delay'
    );
    expect(result).toMatchObject({ status: 'SUCCEEDED', steps: { after: { output: 1500 } } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  }, 60_000);
});
