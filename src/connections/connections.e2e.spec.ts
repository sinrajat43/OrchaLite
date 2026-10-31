import mongoose from 'mongoose';
import { startTestApi, TestApi } from '../testing/api-app';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { ConnectionsService } from './connections.service';
import { SECRET_KEY_ENV } from './secret-box';

describe('connections', () => {
  let api: TestApi;
  let upstream: TestServer;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    upstream = await startTestServer((req, res) => sendJson(res, 200, { auth: req.headers.authorization ?? null, url: req.url }));
    api = await startTestApi();
  }, 60_000);

  afterAll(async () => {
    await api.close();
    await upstream.close();
    jest.restoreAllMocks();
  });

  it('stores a connection encrypted and shows only the names of its secrets', async () => {
    const put = await api.request('PUT', '/connections/upstream', {
      type: 'http',
      baseUrl: upstream.url,
      headers: { Authorization: 'token s3cret' },
      query: { key: 'k3y' },
    });

    expect(put).toMatchObject({
      status: 200,
      body: { name: 'upstream', type: 'http', baseUrl: upstream.url, headerNames: ['Authorization'], queryNames: ['key'] },
    });
    expect(JSON.stringify((await api.request('GET', '/connections')).body)).not.toMatch(/s3cret|k3y/);

    const stored = await mongoose.connection.db.collection('connections').findOne({ name: 'upstream' });
    expect(JSON.stringify(stored)).not.toMatch(/s3cret|k3y/);
  });

  it('lets a step use it by name, so the definition holds no secret', async () => {
    const definition = {
      name: 'uses-connection',
      steps: [{ id: 'call', task: 'http.request', params: { connection: 'upstream', url: '/me' }, dependsOn: [] }],
    };

    const { status, body } = await api.request('POST', '/workflow/run?wait=true', { definition });

    expect(status).toBe(200);
    expect(body.steps.call.output.body).toEqual({ auth: 'token s3cret', url: '/me?key=k3y' });
    expect(body.steps.call.output.url).toBe(`${upstream.url}/me`);
  });

  it('fails the step for an unknown connection', async () => {
    const definition = {
      name: 'missing-connection',
      steps: [{ id: 'call', task: 'http.request', params: { connection: 'nope' }, dependsOn: [] }],
    };

    const { status, body } = await api.request('POST', '/workflow/run?wait=true', { definition });

    expect(status).toBe(500);
    expect(body).toMatchObject({ stepId: 'call', message: 'Task execution failed: Unknown connection "nope"' });
  });

  it('validates what is stored', async () => {
    expect((await api.request('PUT', '/connections/x', { type: 'http', baseUrl: 'not a url' })).status).toBe(400);
    expect((await api.request('PUT', '/connections/x', { type: 'ftp', baseUrl: upstream.url })).status).toBe(400);
    expect((await api.request('PUT', '/connections/x', { type: 'http', baseUrl: upstream.url, headers: { a: 1 } })).status).toBe(400);
    expect((await api.request('PUT', '/connections/bad name', { type: 'http', baseUrl: upstream.url })).status).toBe(400);
  });

  it('deletes a connection', async () => {
    await api.request('PUT', '/connections/temp', { type: 'http', baseUrl: upstream.url });

    expect((await api.request('DELETE', '/connections/temp')).status).toBe(204);
    expect((await api.request('DELETE', '/connections/temp')).status).toBe(404);
  });

  it('is disabled without an encryption key', async () => {
    const key = process.env[SECRET_KEY_ENV];
    delete process.env[SECRET_KEY_ENV];
    try {
      const service = new ConnectionsService();
      await expect(service.put('x', { type: 'http', baseUrl: upstream.url })).rejects.toThrow(`set ${SECRET_KEY_ENV}`);
      await expect(service.get('upstream')).rejects.toThrow(`set ${SECRET_KEY_ENV}`);
    } finally {
      process.env[SECRET_KEY_ENV] = key;
    }
  });
});
