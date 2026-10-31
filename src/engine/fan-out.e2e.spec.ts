import { startTestApi, TestApi } from '../testing/api-app';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { until } from '../testing/wait';

describe('fan-out and backpressure', () => {
  let api: TestApi;
  let upstream: TestServer;
  let current = 0;
  let peak = 0;
  const finishedAt = new Map<string, number>();

  const LIMIT = 5;

  const result = (runId: string) => api.request('GET', `/runs/${runId}/result`).then(r => r.body);

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    upstream = await startTestServer((req, res) => {
      current++;
      peak = Math.max(peak, current);
      setTimeout(() => {
        current--;
        finishedAt.set(req.url, Date.now());
        sendJson(res, 200, { url: req.url });
      }, 20);
    });
    process.env.ORCHALITE_WORKER_SLOTS = '32';
    process.env.ORCHALITE_WORKER_POLL_MS = '20';
    process.env.ORCHALITE_RUN_WINDOW = '8';
    api = await startTestApi();
  }, 60_000);

  afterAll(async () => {
    delete process.env.ORCHALITE_WORKER_SLOTS;
    delete process.env.ORCHALITE_WORKER_POLL_MS;
    delete process.env.ORCHALITE_RUN_WINDOW;
    await api.close();
    await upstream.close();
    jest.restoreAllMocks();
  });

  it('a 1,000-item fan-out respects its limit, and does not starve a small run', async () => {
    const big = {
      name: 'big',
      steps: [
        {
          id: 'each',
          task: 'http.request',
          forEach: '{{ [1..1000] }}',
          concurrency: LIMIT,
          params: { url: `${upstream.url}/big/{{ item }}` },
          dependsOn: [],
        },
      ],
    };
    const small = { name: 'small', steps: [{ id: 'one', task: 'http.request', params: { url: `${upstream.url}/small` }, dependsOn: [] }] };

    const bigRun = (await api.request('POST', '/workflow/run', { definition: big })).body.runId;

    // Let the big run get going, so the small one arrives into a busy engine
    await until(async () => finishedAt.size, size => size >= 20, 'the big run to start', 60_000);
    const smallStarted = Date.now();
    const smallRun = (await api.request('POST', '/workflow/run', { definition: small })).body.runId;
    const smallResult = await until(() => result(smallRun), body => body.status !== 'RUNNING', 'the small run', 60_000);
    const smallTook = Date.now() - smallStarted;
    const bigProgress = finishedAt.size;

    expect(smallResult.status).toBe('SUCCEEDED');
    // It finished while the big run still had most of its items to go
    expect(bigProgress).toBeLessThan(700);

    const bigResult = await until(() => result(bigRun), body => body.status !== 'RUNNING', 'the big run', 180_000);

    expect(bigResult.status).toBe('SUCCEEDED');
    expect(bigResult.steps.each.iterations).toBe(1000);
    expect(bigResult.steps.each.output).toHaveLength(1000);
    expect(bigResult.steps.each.output[999].body).toEqual({ url: '/big/1000' });
    // Exactly at the limit: it was used in full and never passed
    expect(peak).toBe(LIMIT);
    expect(smallTook).toBeLessThan(5000);
  }, 240_000);

  it('applies a connection rate limit on a real database across workers', async () => {
    const { MongoRateLimiter } = await import('./rate-limiter');
    const limiter = new MongoRateLimiter();

    expect(await limiter.acquire('demo', 10, 2)).toBe(0);
    const results = await Promise.all(Array.from({ length: 4 }, () => limiter.acquire('demo', 10, 2)));

    // The rest of the burst of 2 goes through, however many ask at once; the others are told to come back
    expect(results.filter(wait => wait === 0)).toHaveLength(1);
    expect(results.filter(wait => wait > 0)).toHaveLength(3);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await limiter.acquire('demo', 10, 2)).toBe(0);
  });

  it('stores a connection rate limit and reports it', async () => {
    const put = await api.request('PUT', '/connections/limited', { type: 'http', baseUrl: upstream.url, rateLimit: { perSecond: 5, burst: 2 } });

    expect(put.status).toBe(200);
    expect(put.body.rateLimit).toEqual({ perSecond: 5, burst: 2 });
  });
});
