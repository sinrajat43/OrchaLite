import mongoose from 'mongoose';
import { startTestApi, TestApi } from '../testing/api-app';
import { loadExample } from '../testing/examples';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';

// The example workflows from the web UI, run end to end through the HTTP API
// against fake upstream services, a throwaway MongoDB and the built-in inbox
describe('example workflows', () => {
  let api: TestApi;
  let upstream: TestServer;
  let release = { tag_name: 'v1.0.0', html_url: 'https://example.test/v1.0.0' };

  const repos = [
    { full_name: 'nestjs/nest', stargazers_count: 70000, language: 'TypeScript', id: 1 },
    { full_name: 'nestjs/docs', stargazers_count: 1500, language: null, id: 2 },
    { full_name: 'nestjs/tiny', stargazers_count: 10, language: 'Go', id: 3 },
  ];

  const run = (definition: unknown, input: unknown) => api.request('POST', '/workflow/run', { definition, input });
  const inbox = async (channel: string) =>
    (await api.request('GET', '/inbox')).body.filter((m: { channel: string }) => m.channel === channel);

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    upstream = await startTestServer((req, res) => {
      if (req.url.startsWith('/search/repositories')) return sendJson(res, 200, { total_count: repos.length, items: repos });
      if (req.url === '/repos/acme/app/releases/latest') return sendJson(res, 200, release);
      if (req.url === '/up') return sendJson(res, 200, { ok: true });
      if (req.url === '/down') return sendJson(res, 503, { error: 'maintenance' });
      sendJson(res, 404, { message: 'Not Found' });
    });
    api = await startTestApi();
  }, 60_000);

  afterAll(async () => {
    await api.close();
    await upstream.close();
    jest.restoreAllMocks();
  });

  it('uptime-alert: checks every endpoint and notifies with the ones that are down', async () => {
    const { workflow } = loadExample('uptime-alert');
    const endpoints = [`${upstream.url}/up`, `${upstream.url}/down`, 'http://127.0.0.1:9/'];

    const { status, body } = await run(workflow, { endpoints, webhookUrl: `${api.url}/inbox/uptime` });

    expect(status).toBe(201);
    expect(body.steps.check).toMatchObject({ status: 'succeeded', iterations: 3 });
    expect(body.steps.down.output.map((r: { url: string }) => r.url)).toEqual(endpoints.slice(1));
    expect(body.steps.alert.status).toBe('succeeded');

    const [message] = await inbox('uptime');
    expect(message.payload.text).toBe(`2 of 3 endpoints down: ${endpoints[1]}, ${endpoints[2]}`);
    expect(message.payload.down).toEqual([
      { url: endpoints[1], status: 503, error: expect.stringContaining('HTTP 503') },
      { url: endpoints[2], status: 0, error: expect.stringContaining('failed') },
    ]);
  });

  it('uptime-alert: stays quiet when everything is up', async () => {
    const { workflow } = loadExample('uptime-alert');
    const before = (await inbox('uptime')).length;

    const { body } = await run(workflow, { endpoints: [`${upstream.url}/up`], webhookUrl: `${api.url}/inbox/uptime` });

    expect(body.steps.alert).toEqual({ status: 'skipped', reason: 'when was false' });
    expect(await inbox('uptime')).toHaveLength(before);
  });

  it('release-watcher: notifies once per new release, remembering the last one in MongoDB', async () => {
    const { workflow } = loadExample('release-watcher');
    const input = { repo: 'acme/app', apiUrl: upstream.url, webhookUrl: `${api.url}/inbox/releases` };

    const first = await run(workflow, input);
    expect(first.status).toBe(201);
    expect(first.body.steps.notify.status).toBe('succeeded');
    expect(first.body.steps.record.output).toEqual({ created: true, modified: false });

    const second = await run(workflow, input);
    expect(second.body.steps.notify).toEqual({ status: 'skipped', reason: 'when was false' });
    expect(second.body.steps.record).toEqual({ status: 'skipped', reason: 'dependency "notify" was skipped' });

    release = { tag_name: 'v1.1.0', html_url: 'https://example.test/v1.1.0' };
    const third = await run(workflow, input);
    expect(third.body.steps.notify.status).toBe('succeeded');

    const messages = await inbox('releases');
    expect(messages.map((m: { payload: unknown }) => m.payload)).toEqual([
      { text: 'acme/app released v1.1.0: https://example.test/v1.1.0', previous: 'v1.0.0' },
      { text: 'acme/app released v1.0.0: https://example.test/v1.0.0' },
    ]);
    const stored = await mongoose.connection.db.collection('release_watch').findOne({ repo: 'acme/app' });
    expect(stored.tag).toBe('v1.1.0');
  });

  it('popular-repos: searches, filters, reshapes and stores, using primitives only', async () => {
    const { workflow, input } = loadExample('popular-repos');

    const { status, body } = await run(workflow, { ...input, apiUrl: upstream.url });

    expect(status).toBe(201);
    expect(upstream.requests.find(r => r.url.startsWith('/search'))?.url).toBe(
      '/search/repositories?q=org:nestjs&sort=stars&order=desc&per_page=100'
    );
    expect(body.steps.summary.output).toEqual([
      { name: 'nestjs/nest', stars: 70000, language: 'TypeScript' },
      { name: 'nestjs/docs', stars: 1500, language: null },
    ]);
    expect(body.steps.save.output).toEqual({ insertedCount: 1 });

    const [stored] = await mongoose.connection.db.collection('repos').find().toArray();
    expect(stored.org).toBe('nestjs');
    expect(stored.repos).toHaveLength(2);
    expect(stored.timestamp).toBeInstanceOf(Date);
  });

  it('popular-repos: the input schema rejects an org that could add search qualifiers', async () => {
    const { workflow } = loadExample('popular-repos');

    const { status, body } = await run(workflow, { org: 'nestjs stars:>1' });

    expect(status).toBe(400);
    expect(body.errors).toEqual(['input.org must match pattern "^[A-Za-z0-9-]+$"']);
  });

  it.each(['undeclared-dependency', 'bad-params', 'cycle-example'])('%s is rejected before anything runs', async name => {
    const { workflow, input } = loadExample(name);

    const { status, body } = await run(workflow, input);

    expect(status).toBe(400);
    expect(body.message).toBe('Invalid workflow definition');
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
