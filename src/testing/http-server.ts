import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type Handler = (request: RecordedRequest, response: ServerResponse) => void;

/**
 * Starts an HTTP server on a free port that records every request (JSON
 * bodies parsed) and answers with the handler
 */
export async function startTestServer(handler: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // keep the text
      }
      const recorded = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
        // Idle keep-alive sockets would otherwise hold close() open
        server.closeAllConnections();
      }),
  };
}

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Closes a Nest app without waiting out the test client's keep-alive sockets
 */
export async function closeApp(app: { getHttpServer(): any; close(): Promise<void> }): Promise<void> {
  const server = app.getHttpServer();
  const closing = app.close();
  server.closeAllConnections();
  await closing;
}
