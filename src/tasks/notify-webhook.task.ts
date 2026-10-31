import axios from 'axios';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext, TerminalTaskError } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { ConnectionParam, isTerminalStatus, requireUrlOrConnection, resolveTarget } from './http-connection';

const NotifyWebhookParamsSchema = Type.Object(
  {
    url: Type.Optional(Type.String({ minLength: 1, description: 'Webhook URL; may be left to the connection' })),
    connection: ConnectionParam,
    payload: Type.Unknown({ description: 'Sent as the JSON body, for example { "text": "..." } for Slack' }),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000, default: 10_000 })),
  },
  { additionalProperties: false }
);
export type NotifyWebhookParams = Static<typeof NotifyWebhookParamsSchema>;

const NotifyWebhookOutputSchema = Type.Object({ status: Type.Integer() });
export type NotifyWebhookOutput = Static<typeof NotifyWebhookOutputSchema>;

@TaskHandler({ name: 'notify.webhook', version: 1, description: 'POSTs a JSON payload to a webhook; fails unless it answers 2xx' })
export class NotifyWebhookTask implements Task<NotifyWebhookParams, NotifyWebhookOutput> {
  readonly paramsSchema = NotifyWebhookParamsSchema;
  readonly outputSchema = NotifyWebhookOutputSchema;

  validate(params: Record<string, unknown>): string[] {
    return requireUrlOrConnection(params);
  }

  async execute(ctx: TaskContext<NotifyWebhookParams>): Promise<NotifyWebhookOutput> {
    const { params, signal } = ctx;
    const { payload, timeoutMs = 10_000 } = params;
    // A webhook URL is often itself the secret (Slack), so errors name the connection instead
    const shown = params.connection ? `connection "${params.connection}"` : params.url;
    const { url, headers, query } = await resolveTarget(ctx, params.connection, params);
    try {
      const response = await axios.post(url, payload ?? null, {
        // A step can run more than once; this lets the receiver recognise a repeat
        headers: { 'Idempotency-Key': ctx.idempotencyKey, ...headers },
        params: query,
        timeout: timeoutMs,
        signal,
      });
      return { status: response.status };
    } catch (error) {
      const response = axios.isAxiosError(error) ? error.response : undefined;
      const message = `Webhook ${shown} failed: ${response ? `HTTP ${response.status}` : (error as Error).message}`;
      throw response && isTerminalStatus(response.status) ? new TerminalTaskError(message) : new Error(message);
    }
  }
}
