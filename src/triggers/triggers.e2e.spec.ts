import mongoose from 'mongoose';
import { startTestApi, TestApi } from '../testing/api-app';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { until } from '../testing/wait';
import { signDelivery } from './triggers.service';

const SECRET = 'a-long-enough-signing-secret';

describe('webhook automation with rollback', () => {
  let api: TestApi;
  let crm: TestServer;
  let billing: TestServer;
  let inventory: TestServer;
  let sink: TestServer;
  const stock = new Map<string, number>();
  let billingStatus = 402;

  const result = (runId: string) => api.request('GET', `/runs/${runId}/result`).then(r => r.body);
  const finished = (runId: string) => until(() => result(runId), body => !['RUNNING', 'COMPENSATING'].includes(body.status), `run ${runId}`);

  const deliver = (name: string, body: unknown, overrides: { secret?: string; timestamp?: string; delivery?: string; signature?: string } = {}) => {
    const raw = JSON.stringify(body);
    const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
    return fetch(`${api.url}/hooks/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orchalite-Timestamp': timestamp,
        'X-Orchalite-Signature': overrides.signature ?? signDelivery(overrides.secret ?? SECRET, timestamp, raw),
        ...(overrides.delivery ? { 'X-Orchalite-Delivery': overrides.delivery } : {}),
      },
      body: raw,
    }).then(async response => ({ status: response.status, body: await response.json() }));
  };

  // Receive an order, look up the customer, reserve stock, charge. A declined
  // charge has to give the reserved stock back.
  const automation = () => ({
    name: 'order-automation',
    input: { order: 'object' },
    steps: [
      { id: 'customer', task: 'http.request', params: { url: `${crm.url}/customers/{{ input.order.customer }}` }, dependsOn: [] },
      {
        id: 'reserve',
        task: 'http.request',
        dependsOn: ['customer'],
        params: { method: 'POST', url: `${inventory.url}/reserve`, body: { sku: '{{ input.order.sku }}' } },
        compensate: {
          task: 'http.request',
          params: { method: 'POST', url: `${inventory.url}/release`, body: { reservation: '{{ steps.reserve.output.body.reservation }}', sku: '{{ input.order.sku }}' } },
          retry: { maxAttempts: 3, backoffMs: 10 },
        },
      },
      {
        id: 'charge',
        task: 'http.request',
        dependsOn: ['reserve'],
        params: { method: 'POST', url: `${billing.url}/charge`, body: { customer: '{{ steps.customer.output.body.id }}' } },
      },
    ],
  });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    crm = await startTestServer((req, res) => sendJson(res, 200, { id: req.url.split('/').pop(), tier: 'gold' }));
    inventory = await startTestServer((req, res) => {
      const { sku, reservation } = req.body as { sku: string; reservation?: string };
      if (req.url === '/reserve') {
        stock.set(sku, (stock.get(sku) ?? 10) - 1);
        return sendJson(res, 200, { reservation: `r-${sku}` });
      }
      stock.set(sku, stock.get(sku) + 1);
      sendJson(res, 200, { released: reservation });
    });
    billing = await startTestServer((_req, res) => sendJson(res, billingStatus, { declined: billingStatus === 402 }));
    sink = await startTestServer((_req, res) => sendJson(res, 200, {}));

    process.env.ORCHALITE_EVENTS_WEBHOOK_URL = `${sink.url}/events`;
    process.env.ORCHALITE_SCHEDULER_INTERVAL_MS = '50';
    process.env.ORCHALITE_LEADER_TTL_MS = '2000';
    api = await startTestApi();

    expect((await api.request('POST', '/workflows', automation())).status).toBe(201);
    const put = await api.request('PUT', '/triggers/orders', {
      type: 'webhook',
      workflow: 'order-automation',
      secret: SECRET,
      input: { order: '{{ body }}' },
    });
    expect(put.status).toBe(200);
    expect(put.body).not.toHaveProperty('secret');
    // Leadership is only checked periodically; a test should not race it
    await new Promise(resolve => setTimeout(resolve, 100));
  }, 60_000);

  afterAll(async () => {
    delete process.env.ORCHALITE_EVENTS_WEBHOOK_URL;
    delete process.env.ORCHALITE_SCHEDULER_INTERVAL_MS;
    delete process.env.ORCHALITE_LEADER_TTL_MS;
    await api.close();
    await Promise.all([crm, inventory, billing, sink].map(server => server.close()));
    jest.restoreAllMocks();
  });

  it('rolls back cleanly when its last step fails', async () => {
    const delivered = await deliver('orders', { customer: 'c1', sku: 'widget' }, { delivery: 'd-1' });
    expect(delivered.status).toBe(202);

    const run = await finished(delivered.body.runId);

    expect(run).toMatchObject({
      status: 'COMPENSATED',
      failedStepId: 'charge',
      steps: {
        customer: { status: 'succeeded' },
        reserve: { status: 'succeeded', compensation: 'succeeded' },
        charge: { status: 'failed' },
      },
    });
    expect(run.error).toContain('HTTP 402');
    expect(stock.get('widget')).toBe(10);
    expect(inventory.requests.at(-1)).toMatchObject({ url: '/release', body: { reservation: 'r-widget', sku: 'widget' } });
    expect(inventory.requests.at(-1).headers['idempotency-key']).toBe(`${delivered.body.runId}:reserve:compensate`);

    const events = (await api.request('GET', `/runs/${delivered.body.runId}/events`)).body.map((e: any) => e.type);
    expect(events.slice(-4)).toEqual(['RunCompensating', 'CompensationStarted', 'CompensationSucceeded', 'RunCompensated']);
  });

  it('commits when every step succeeds, and undoes nothing', async () => {
    billingStatus = 200;
    const delivered = await deliver('orders', { customer: 'c2', sku: 'gadget' });

    const run = await finished(delivered.body.runId);
    billingStatus = 402;

    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.reserve.compensation).toBeUndefined();
    expect(stock.get('gadget')).toBe(9);
  });

  it('retries a failed undo, and ends needing a person if it cannot', async () => {
    const definition = {
      name: 'stuck-rollback',
      steps: [
        {
          id: 'first',
          task: 'transform',
          params: { value: 1 },
          dependsOn: [],
          compensate: { task: 'http.request', params: { method: 'POST', url: `${billing.url}/never` }, retry: { maxAttempts: 2, backoffMs: 5 } },
        },
        { id: 'second', task: 'http.request', params: { url: `${crm.url}/x`, method: 'POST', query: { n: '{{ $error("no") }}' } }, dependsOn: ['first'] },
      ],
    };
    billingStatus = 503;

    const { body } = await api.request('POST', '/workflow/run', { definition });
    const run = await finished(body.runId);
    billingStatus = 402;

    expect(run).toMatchObject({ status: 'COMPENSATION_FAILED', failedStepId: 'second', steps: { first: { compensation: 'failed' } } });
    expect(run.steps.first.compensationError).toContain('Gave up after 2 attempts');
  });

  describe('signature checks', () => {
    it.each([
      ['the wrong secret', { secret: 'some-other-secret-entirely' }],
      ['no valid signature', { signature: 'sha256=00' }],
      ['an old timestamp', { timestamp: String(Math.floor(Date.now() / 1000) - 3600) }],
      ['no timestamp', { timestamp: 'nope' }],
    ])('refuses %s', async (_name, overrides) => {
      const before = (await api.request('GET', '/runs?name=order-automation&limit=100')).body.length;

      const { status } = await deliver('orders', { customer: 'x', sku: 'y' }, overrides);

      expect(status).toBe(401);
      expect((await api.request('GET', '/runs?name=order-automation&limit=100')).body).toHaveLength(before);
    });

    it('checks the bytes that arrived, so a changed body fails', async () => {
      const raw = JSON.stringify({ customer: 'c', sku: 's' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetch(`${api.url}/hooks/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orchalite-Timestamp': timestamp, 'X-Orchalite-Signature': signDelivery(SECRET, timestamp, raw) },
        body: JSON.stringify({ customer: 'c', sku: 'other' }),
      });

      expect(response.status).toBe(401);
    });

    it('treats a repeated delivery as one run', async () => {
      const first = await deliver('orders', { customer: 'c3', sku: 'repeat' }, { delivery: 'same-delivery' });
      const second = await deliver('orders', { customer: 'c3', sku: 'repeat' }, { delivery: 'same-delivery' });

      expect(second.body.runId).toBe(first.body.runId);
      await finished(first.body.runId);
      expect(stock.get('repeat')).toBe(10);
    });

    it('is 404 for an unknown hook', async () => {
      expect((await deliver('nope', {})).status).toBe(404);
    });
  });

  it('generates a secret once, and never shows it again', async () => {
    const put = await api.request('PUT', '/triggers/generated', { type: 'webhook', workflow: 'order-automation', input: { order: '{{ body }}' } });

    expect(put.body.secret).toEqual(expect.any(String));
    const listed = (await api.request('GET', '/triggers')).body.find((t: any) => t.name === 'generated');
    expect(listed.workflow).toBe('order-automation');
    expect(listed).not.toHaveProperty('secret');
    expect((await deliver('generated', { customer: 'c', sku: 's' }, { secret: put.body.secret })).status).toBe(202);
    expect((await api.request('DELETE', '/triggers/generated')).status).toBe(204);
    expect((await api.request('DELETE', '/triggers/generated')).status).toBe(404);
  });

  describe('cron', () => {
    const put = (name: string, body: object) => api.request('PUT', `/triggers/${name}`, { type: 'cron', ...body });

    it('rejects a bad schedule or an unknown workflow', async () => {
      await api.request('POST', '/workflows', { name: 'tick', steps: [{ id: 'a', task: 'transform', params: { value: 1 }, dependsOn: [] }] });

      expect((await put('bad', { workflow: 'tick', cron: 'whenever' })).status).toBe(400);
      expect((await put('bad', { workflow: 'tick' })).status).toBe(400);
      expect((await put('bad', { workflow: 'nope', cron: '* * * * *' })).status).toBe(400);
    });

    it('runs a stored workflow on schedule, once per scheduled time', async () => {
      const created = await put('every-second', { workflow: 'tick', cron: '* * * * * *' });
      expect(created.status).toBe(200);
      expect(Date.parse(created.body.nextRunAt)).toBeGreaterThan(Date.now() - 1000);

      const runs = await until(
        async () => (await api.request('GET', '/runs?name=tick&limit=100')).body,
        (list: any[]) => list.length >= 3,
        'three firings',
        15_000
      );
      await api.request('DELETE', '/triggers/every-second');

      expect(runs[0]).toMatchObject({ name: 'tick', workflow: { name: 'tick', version: 1 } });
      // Each firing's key names its scheduled second, so no second can have two runs
      const requests = await mongoose.connection.db.collection('run_requests').find({ _id: { $regex: '^cron:every-second:' } as any }).toArray();
      expect(new Set(requests.map(r => r.runId)).size).toBe(requests.length);
      expect(requests.length).toBeGreaterThanOrEqual(3);
    }, 20_000);
  });

  it('publishes every event through the outbox, in order within a run', async () => {
    const delivered = await deliver('orders', { customer: 'outbox', sku: 'o' });
    const { runId } = delivered.body;
    await finished(runId);

    const seen = () => sink.requests.flatMap(r => r.body as any[]).filter(e => e.runId === runId);
    const events = await until(async () => seen(), list => list.some(e => e.type === 'RunCompensated'), 'the outbox to catch up');

    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0].type).toBe('RunStarted');
    expect(events).not.toContainEqual(expect.objectContaining({ published: expect.anything() }));
  });
});
