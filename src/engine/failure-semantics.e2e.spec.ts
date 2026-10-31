import { startTestApi, TestApi } from '../testing/api-app';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { until } from '../testing/wait';

describe('failure semantics', () => {
  let api: TestApi;
  let upstream: TestServer;
  const charges = new Map<string, number>();
  let failuresLeft = 0;
  let failWith = 503;

  const finished = (runId: string) =>
    until(async () => (await api.request('GET', `/runs/${runId}/result`)).body, body => body.status !== 'RUNNING', `run ${runId}`);

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    // A payment API that recognises repeats by key, and goes wrong AFTER doing the
    // work, the case where a naive retry would charge twice
    upstream = await startTestServer((req, res) => {
      const key = req.headers['idempotency-key'] as string;
      if (key && !charges.has(key)) charges.set(key, (req.body as { amount: number }).amount);
      if (failuresLeft > 0) {
        failuresLeft--;
        return sendJson(res, failWith, { error: 'try later' });
      }
      sendJson(res, 200, { charged: charges.get(key), charges: charges.size });
    });
    api = await startTestApi();
  }, 60_000);

  afterAll(async () => {
    await api.close();
    await upstream.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    charges.clear();
    upstream.requests.length = 0;
    failuresLeft = 0;
    failWith = 503;
  });

  const charge = (retry: unknown = { maxAttempts: 3, backoffMs: 10 }) => ({
    name: 'charge',
    steps: [{ id: 'pay', task: 'http.request', params: { method: 'POST', url: `${upstream.url}/charge`, body: { amount: 42 } }, retry, dependsOn: [] }],
  });

  it('a step that fails twice then succeeds produces its side effect exactly once', async () => {
    failuresLeft = 2;

    const { body } = await api.request('POST', '/workflow/run', { definition: charge() });
    const result = await finished(body.runId);

    expect(result.status).toBe('SUCCEEDED');
    expect(result.steps.pay).toMatchObject({ status: 'succeeded', retries: 2 });
    expect(result.steps.pay.output.body).toEqual({ charged: 42, charges: 1 });
    // Three deliveries of one effect, all under one key
    expect(upstream.requests).toHaveLength(3);
    expect(new Set(upstream.requests.map(r => r.headers['idempotency-key']))).toEqual(new Set([`${body.runId}:pay`]));
    expect(charges.size).toBe(1);

    const retries = (await api.request('GET', `/runs/${body.runId}/events`)).body.filter((e: any) => e.type === 'StepRetryScheduled');
    expect(retries.map((e: any) => e.data.attempt)).toEqual([1, 2]);
    expect(retries[0].data.error).toContain('HTTP 503');
  });

  it('does not retry a client error', async () => {
    failuresLeft = 1;
    failWith = 400;

    const { body } = await api.request('POST', '/workflow/run', { definition: charge() });
    const result = await finished(body.runId);

    expect(result).toMatchObject({ status: 'FAILED', failedStepId: 'pay', steps: { pay: { status: 'failed' } } });
    expect(upstream.requests).toHaveLength(1);
  });

  it('retries a 429', async () => {
    failuresLeft = 1;
    failWith = 429;

    const { body } = await api.request('POST', '/workflow/run', { definition: charge() });

    expect((await finished(body.runId)).status).toBe('SUCCEEDED');
    expect(upstream.requests).toHaveLength(2);
  });

  it('puts a step out of attempts in the dead letters, with why', async () => {
    failuresLeft = 99;

    const { body } = await api.request('POST', '/workflow/run', { definition: charge({ maxAttempts: 2, backoffMs: 5 }) });
    const result = await finished(body.runId);

    expect(result).toMatchObject({ status: 'FAILED', failedStepId: 'pay', steps: { pay: { status: 'dead_lettered', retries: 1 } } });
    expect(result.error).toMatch(/^Gave up after 2 attempts: .*HTTP 503/);

    const letters = await api.request('GET', '/dead-letters');
    expect(letters.status).toBe(200);
    expect(letters.body[0]).toMatchObject({ runId: body.runId, stepId: 'pay', status: 'DEAD_LETTERED', failures: [{ attempt: 1 }] });
  });

  it('sends the key only with writes', async () => {
    const definition = { name: 'read', steps: [{ id: 'get', task: 'http.request', params: { url: `${upstream.url}/x` }, dependsOn: [] }] };
    await api.request('POST', '/workflow/run?wait=true', { definition }).catch(() => undefined);

    expect(upstream.requests[0].headers['idempotency-key']).toBeUndefined();
  });

  describe('trigger API', () => {
    const start = (key: string, definition: unknown, input?: unknown) =>
      fetch(`${api.url}/workflow/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ definition, input }),
      }).then(async response => ({ status: response.status, body: await response.json() }));

    const definition = { name: 'keyed', input: { n: 'integer' }, steps: [{ id: 'a', task: 'transform', params: { value: '{{ input.n }}' }, dependsOn: [] }] };

    it('starts one run however many times a request is repeated, even at once', async () => {
      const responses = await Promise.all(Array.from({ length: 5 }, () => start('order-1', definition, { n: 1 })));

      expect(responses.every(r => r.status === 202)).toBe(true);
      const ids = new Set(responses.map(r => r.body.runId));
      expect(ids.size).toBe(1);
      const [runId] = ids;
      expect((await finished(runId)).status).toBe('SUCCEEDED');
      expect((await start('order-1', definition, { n: 1 })).body).toEqual({ runId, status: 'SUCCEEDED' });
      expect((await api.request('GET', '/runs?name=keyed&limit=100')).body.filter((r: any) => r.id === runId)).toHaveLength(1);
      const events = (await api.request('GET', `/runs/${runId}/events`)).body;
      expect(events.filter((e: any) => e.type === 'RunStarted')).toHaveLength(1);
    });

    it('refuses a key reused for a different request', async () => {
      expect((await start('order-2', definition, { n: 1 })).status).toBe(202);

      const reused = await start('order-2', definition, { n: 2 });

      expect(reused.status).toBe(409);
      expect(reused.body.message).toContain('order-2');
    });

    it('does not use up a key on a rejected request', async () => {
      expect((await start('order-3', definition, { n: 'x' })).status).toBe(400);
      expect((await start('order-3', definition, { n: 3 })).status).toBe(202);
    });
  });

  it('the inbox recognises a repeated notification by its key', async () => {
    const definition = {
      name: 'notify-once',
      steps: [{ id: 'tell', task: 'notify.webhook', params: { url: `${api.url}/inbox/once`, payload: { text: 'hi' } }, dependsOn: [] }],
    };
    const { body } = await api.request('POST', '/workflow/run?wait=true', { definition });
    expect(body.status).toBe('SUCCEEDED');

    // What a redelivered step would send
    await fetch(`${api.url}/inbox/once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${body.runId}:tell` },
      body: JSON.stringify({ text: 'hi' }),
    });

    const messages = (await api.request('GET', '/inbox')).body.filter((m: { channel: string }) => m.channel === 'once');
    expect(messages).toHaveLength(1);
  });
});
