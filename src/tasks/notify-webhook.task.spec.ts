import { connectionsOf, contextFor } from '../testing/task-context';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { NotifyWebhookTask } from './notify-webhook.task';

describe('notify.webhook', () => {
  const task = new NotifyWebhookTask();
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((req, res) => sendJson(res, req.url === '/broken' ? 500 : 200, { ok: true }));
  });

  afterAll(() => server.close());

  it('POSTs the payload as JSON with the given headers', async () => {
    const result = await task.execute(
      contextFor({ url: `${server.url}/hook`, payload: { text: 'hello' }, headers: { 'X-Token': 't' } })
    );

    expect(result).toEqual({ status: 200 });
    const [request] = server.requests.slice(-1);
    expect(request).toMatchObject({ method: 'POST', url: '/hook', body: { text: 'hello' } });
    expect(request.headers['x-token']).toBe('t');
    expect(request.headers['content-type']).toContain('application/json');
  });

  it('fails unless the webhook answers 2xx', async () => {
    await expect(task.execute(contextFor({ url: `${server.url}/broken`, payload: {} }))).rejects.toThrow(
      `Webhook ${server.url}/broken failed: HTTP 500`
    );
  });

  it('can take its URL from a connection, and keeps it out of errors', async () => {
    const slack = (path: string) =>
      connectionsOf({ name: 'slack', type: 'http', baseUrl: `${server.url}${path}`, headers: {}, query: {} });

    await task.execute(contextFor({ connection: 'slack', payload: { text: 'hi' } }, slack('/services/T/B/secret')));
    expect(server.requests.slice(-1)[0]).toMatchObject({ url: '/services/T/B/secret', body: { text: 'hi' } });

    const error = await task.execute(contextFor({ connection: 'slack', payload: {} }, slack('/broken'))).catch(e => e);
    expect(error.message).toBe('Webhook connection "slack" failed: HTTP 500');
  });
});
