import axios from 'axios';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';

const HttpRequestParamsSchema = Type.Object(
  {
    method: Type.Optional(
      Type.Union(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(m => Type.Literal(m)), { default: 'GET' })
    ),
    url: Type.String({ minLength: 1, description: 'Absolute URL' }),
    query: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.Unknown({ description: 'Sent as JSON' })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000, default: 30_000 })),
    throwOnError: Type.Optional(
      Type.Boolean({
        default: true,
        description: 'Fail the step on a network error or a non-2xx status; when false, report it in the output',
      })
    ),
  },
  { additionalProperties: false }
);
export type HttpRequestParams = Static<typeof HttpRequestParamsSchema>;

const HttpResponseSchema = Type.Object({
  ok: Type.Boolean({ description: 'True for a 2xx status' }),
  status: Type.Integer({ description: '0 when no response arrived' }),
  headers: Type.Record(Type.String(), Type.String()),
  body: Type.Unknown({ description: 'Parsed JSON, or text' }),
  durationMs: Type.Integer(),
  error: Type.Optional(Type.String()),
});
export type HttpResponse = Static<typeof HttpResponseSchema>;

const snippet = (body: unknown) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body) ?? '';
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};

@TaskHandler({ name: 'http.request', version: 1, description: 'Calls an HTTP endpoint and returns its status, headers and body' })
export class HttpRequestTask implements Task<HttpRequestParams, HttpResponse> {
  readonly paramsSchema = HttpRequestParamsSchema;
  readonly outputSchema = HttpResponseSchema;

  async execute({ params, signal }: TaskContext<HttpRequestParams>): Promise<HttpResponse> {
    const { method = 'GET', url, query, headers, body, timeoutMs = 30_000, throwOnError = true } = params;
    const started = Date.now();

    let response;
    try {
      response = await axios.request({
        method,
        url,
        params: query,
        headers,
        data: body,
        timeout: timeoutMs,
        signal,
        // Every status is a response here; throwOnError decides what a failure is
        validateStatus: () => true,
      });
    } catch (error) {
      const message = `${method} ${url} failed: ${(error as Error).message}`;
      if (throwOnError) throw new Error(message);
      return { ok: false, status: 0, headers: {}, body: null, durationMs: Date.now() - started, error: message };
    }

    const result: HttpResponse = {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])),
      body: response.data,
      durationMs: Date.now() - started,
    };
    if (!result.ok) {
      result.error = `${method} ${url} returned HTTP ${response.status}: ${snippet(response.data)}`;
      if (throwOnError) throw new Error(result.error);
    }
    return result;
  }
}
