import axios from 'axios';
import { contextFor } from '../testing/task-context';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { HttpRequestTask } from './http-request.task';
import { NotifyWebhookTask } from './notify-webhook.task';
import { BLOCK_PRIVATE_NETWORK_ENV, isBlockedAddress, outboundConfig } from './outbound-guard';

describe('outbound guard', () => {
  let server: TestServer;
  const http = new HttpRequestTask();
  const webhook = new NotifyWebhookTask();

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if (req.url.startsWith('/to-ip')) return res.writeHead(302, { Location: `${server.url}/` }).end();
      if (req.url.startsWith('/to-name')) return res.writeHead(302, { Location: `${server.url.replace('127.0.0.1', 'localhost')}/` }).end();
      sendJson(res, 200, { reached: true });
    });
  });

  afterAll(() => server.close());

  afterEach(() => {
    delete process.env[BLOCK_PRIVATE_NETWORK_ENV];
  });

  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:192.168.1.1',
  ])('blocks %s', address => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:1.1.1.1'])('allows %s', address => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  describe('when off', () => {
    it('adds nothing, and tasks reach private addresses', async () => {
      expect(outboundConfig('http://127.0.0.1/')).toEqual({});
      expect(await http.execute(contextFor({ url: server.url }))).toMatchObject({ ok: true, body: { reached: true } });
    });
  });

  describe('when on', () => {
    beforeEach(() => {
      process.env[BLOCK_PRIVATE_NETWORK_ENV] = 'true';
    });

    it.each([
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      // Spellings of 127.0.0.1 that a URL parser normalises
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
    ])('refuses %s without a request', url => {
      expect(() => outboundConfig(url)).toThrow('private network');
    });

    it('refuses a redirect hook call for a private address', () => {
      const { beforeRedirect } = outboundConfig('https://example.com/');
      expect(() => beforeRedirect({ hostname: '169.254.169.254' }, {} as any)).toThrow('private network');
      expect(() => beforeRedirect({ hostname: '[::1]' }, {} as any)).toThrow('private network');
      expect(() => beforeRedirect({ hostname: '1.1.1.1' }, {} as any)).not.toThrow();
    });

    // A bare IP address skips the lookup, so a first request made with these options
    // reaches the local server, and only the redirect is left for the guard to stop
    it.each(['/to-ip', '/to-name'])('stops following a real redirect at %s', async path => {
      await expect(axios.get(`${server.url}${path}`, outboundConfig('https://example.com/'))).rejects.toThrow('private network');
    });

    it('stops http.request reaching a private IP address', async () => {
      await expect(http.execute(contextFor({ url: server.url }))).rejects.toThrow('private network');
    });

    it('stops http.request reaching a name that resolves to a private address', async () => {
      const url = server.url.replace('127.0.0.1', 'localhost');
      await expect(http.execute(contextFor({ url }))).rejects.toThrow('private network');
    });

    it('reports it in the output when http.request does not throw on errors', async () => {
      const result = await http.execute(contextFor({ url: server.url, throwOnError: false }));
      expect(result).toMatchObject({ ok: false, status: 0 });
      expect(result.error).toContain('private network');
    });

    it('stops notify.webhook reaching private addresses', async () => {
      await expect(webhook.execute(contextFor({ url: server.url, payload: {} }))).rejects.toThrow('private network');
      const url = server.url.replace('127.0.0.1', 'localhost');
      await expect(webhook.execute(contextFor({ url, payload: {} }))).rejects.toThrow('private network');
    });
  });
});
