import { contextFor } from '../testing/task-context';
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
});
