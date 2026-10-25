import { connectionsOf, contextFor } from '../testing/task-context';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { HttpRequestTask } from './http-request.task';

describe('http.request', () => {
  const task = new HttpRequestTask();
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if (req.url.startsWith('/missing')) return sendJson(res, 404, { message: 'Not Found' });
      if (req.url.startsWith('/text')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('pong');
      }
      if (req.url.startsWith('/slow')) return setTimeout(() => sendJson(res, 200, {}), 500);
      sendJson(res, 200, { method: req.method, url: req.url, body: req.body, auth: req.headers.authorization ?? null });
    });
  });

  afterAll(() => server.close());

  it('sends method, query, headers and a JSON body, and returns the parsed response', async () => {
    const result = await task.execute(
      contextFor({
        method: 'POST',
        url: `${server.url}/echo`,
        query: { q: 'org:nestjs', per_page: 5 },
        headers: { Authorization: 'token abc' },
        body: { a: 1 },
      })
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: { method: 'POST', url: '/echo?q=org:nestjs&per_page=5', body: { a: 1 }, auth: 'token abc' },
    });
    expect(result.headers['content-type']).toContain('application/json');
    expect(result.durationMs).toEqual(expect.any(Number));
  });

  it('returns a text body as a string', async () => {
    expect((await task.execute(contextFor({ url: `${server.url}/text` }))).body).toBe('pong');
  });

  it('fails the step on a non-2xx status, quoting the body', async () => {
    await expect(task.execute(contextFor({ url: `${server.url}/missing` }))).rejects.toThrow(
      `GET ${server.url}/missing returned HTTP 404: {"message":"Not Found"}`
    );
  });

  it('reports failures in the output when throwOnError is false', async () => {
    const notFound = await task.execute(contextFor({ url: `${server.url}/missing`, throwOnError: false }));
    expect(notFound).toMatchObject({ ok: false, status: 404, body: { message: 'Not Found' } });
    expect(notFound.error).toContain('returned HTTP 404');

    // Port 9 (discard) refuses connections on a normal machine
    const unreachable = await task.execute(contextFor({ url: 'http://127.0.0.1:9/', throwOnError: false }));
    expect(unreachable).toMatchObject({ ok: false, status: 0, body: null });
    expect(unreachable.error).toContain('failed');
  });

  it('times out', async () => {
    await expect(task.execute(contextFor({ url: `${server.url}/slow`, timeoutMs: 50 }))).rejects.toThrow('timeout');
  });

  it('stops when the step is aborted', async () => {
    const ctx = contextFor({ url: `${server.url}/slow` });
    const controller = new AbortController();
    const run = task.execute({ ...ctx, signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toThrow('canceled');
  });

  describe('with a connection', () => {
    const api = () => ({
      name: 'api',
      type: 'http' as const,
      baseUrl: `${server.url}/v1/`,
      headers: { Authorization: 'token secret' },
      query: { api_key: 'k' },
    });
    const run = (params: object) => task.execute(contextFor(params as any, connectionsOf(api())));

    it('adds its credentials and resolves url under its baseUrl', async () => {
      const result = await run({ connection: 'api', url: '/echo', query: { q: 1 }, headers: { Authorization: 'mine' } });

      expect(result.body).toMatchObject({ url: '/v1/echo?q=1&api_key=k', auth: 'token secret' });
      // The output and messages never show the connection's query, which may be a key
      expect(result.url).toBe(`${server.url}/v1/echo`);
    });

    it('uses the baseUrl itself when url is omitted, and accepts absolute URLs under it', async () => {
      expect((await run({ connection: 'api' })).body).toMatchObject({ url: '/v1?api_key=k' });
      expect((await run({ connection: 'api', url: `${server.url}/v1/x` })).body).toMatchObject({ url: '/v1/x?api_key=k' });
    });

    it('refuses to send its credentials anywhere else', async () => {
      for (const url of ['https://evil.example/v1/echo', `${server.url}/v10`, `${server.url}/other`]) {
        await expect(run({ connection: 'api', url })).rejects.toThrow('params.url is outside connection "api"');
      }
      expect(server.requests.some(r => r.url.includes('other'))).toBe(false);
    });

    it('fails on an unknown connection', async () => {
      await expect(run({ connection: 'nope', url: '/x' })).rejects.toThrow('Unknown connection "nope"');
    });

    it('needs url or connection', () => {
      expect(task.validate({})).toEqual(['params needs url, connection, or both']);
      expect(task.validate({ connection: 'api' })).toEqual([]);
    });
  });
});
