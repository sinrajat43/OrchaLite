import { startTestApi, TestApi } from '../testing/api-app';
import { DEMO_PASSWORD_ENV } from './basic-auth';

const PASSWORD = 'correct horse:battery';
const basic = (credentials: string) => ({ Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` });

describe('demo password', () => {
  let api: TestApi;

  const status = async (path: string, init: RequestInit = {}) => (await fetch(`${api.url}${path}`, init)).status;
  const post = (path: string, headers: Record<string, string> = {}) =>
    status(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

  describe('when set', () => {
    beforeAll(async () => {
      process.env[DEMO_PASSWORD_ENV] = PASSWORD;
      api = await startTestApi();
    });

    afterAll(async () => {
      delete process.env[DEMO_PASSWORD_ENV];
      await api.close();
    });

    it.each(['/', '/index.html', '/builder.html', '/examples.json', '/tasks', '/runs', '/metrics', '/connections', '/triggers', '/inbox', '/dead-letters'])(
      'asks for it on GET %s',
      async path => {
        const response = await fetch(`${api.url}${path}`);
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('Basic');
      }
    );

    it('asks for it on writes', async () => {
      expect(await post('/workflow/run')).toBe(401);
      expect(await post('/workflows')).toBe(401);
      expect(await status('/inbox', { method: 'DELETE' })).toBe(401);
    });

    it('rejects a wrong password and malformed credentials', async () => {
      expect(await status('/tasks', { headers: basic('demo:wrong') })).toBe(401);
      expect(await status('/tasks', { headers: basic(PASSWORD) })).toBe(401);
      expect(await status('/tasks', { headers: { Authorization: 'Basic' } })).toBe(401);
      expect(await status('/tasks', { headers: { Authorization: `Bearer ${PASSWORD}` } })).toBe(401);
    });

    it('lets the right password through, with any username', async () => {
      expect(await status('/tasks', { headers: basic(`demo:${PASSWORD}`) })).toBe(200);
      expect(await status('/index.html', { headers: basic(`:${PASSWORD}`) })).toBe(200);
    });

    it('leaves webhook deliveries to their signature', async () => {
      const response = await fetch(`${api.url}/hooks/nobody`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
      expect(response.headers.get('www-authenticate')).toBeNull();
    });

    it('opens only posting to the inbox', async () => {
      expect(await post('/inbox/demo')).toBe(200);
      expect(await post('/inbox/demo/extra')).toBe(401);
      expect(await status('/inbox/demo')).toBe(401);
      expect(await post('/hooks/nobody/runs')).toBe(401);
    });
  });

  describe('when not set', () => {
    beforeAll(async () => {
      api = await startTestApi();
    });

    afterAll(() => api.close());

    it('changes nothing', async () => {
      expect(await status('/tasks')).toBe(200);
      expect(await status('/index.html')).toBe(200);
    });
  });
});
