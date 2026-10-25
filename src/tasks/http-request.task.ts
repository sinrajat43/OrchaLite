import axios from 'axios';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { ConnectionParam, requireUrlOrConnection, resolveTarget } from './http-connection';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

const HttpRequestParamsSchema = Type.Object(
  {
    // An enum rather than a union of literals, so a bad value gives one error, not one per method
    method: Type.Optional(
      Type.Unsafe<(typeof METHODS)[number]>({ type: 'string', enum: [...METHODS], default: 'GET' })
    ),
    url: Type.Optional(Type.String({ minLength: 1, description: 'Absolute URL, or a path under the connection' })),
    connection: ConnectionParam,
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
  url: Type.String({ description: 'The URL requested, without connection query params' }),
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

  validate(params: Record<string, unknown>): string[] {
    return requireUrlOrConnection(params);
  }

  async execute(ctx: TaskContext<HttpRequestParams>): Promise<HttpResponse> {
    const { params, signal } = ctx;
    const { method = 'GET', body, timeoutMs = 30_000, throwOnError = true } = params;
    // Messages and output name the URL without the connection's query, which may hold an API key
    const shown = (await resolveTarget(ctx, params.connection, { ...params, query: undefined, headers: undefined })).url;
    const { url, query, headers } = await resolveTarget(ctx, params.connection, params);
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
      const message = `${method} ${shown} failed: ${(error as Error).message}`;
      if (throwOnError) throw new Error(message);
      return { url: shown, ok: false, status: 0, headers: {}, body: null, durationMs: Date.now() - started, error: message };
    }

    const result: HttpResponse = {
      url: shown,
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])),
      body: response.data,
      durationMs: Date.now() - started,
    };
    if (!result.ok) {
      result.error = `${method} ${shown} returned HTTP ${response.status}: ${snippet(response.data)}`;
      if (throwOnError) throw new Error(result.error);
    }
    return result;
  }
}
