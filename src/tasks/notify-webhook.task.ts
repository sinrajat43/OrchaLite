import axios from 'axios';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';

const NotifyWebhookParamsSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
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

  async execute({ params, signal }: TaskContext<NotifyWebhookParams>): Promise<NotifyWebhookOutput> {
    const { url, payload, headers, timeoutMs = 10_000 } = params;
    try {
      const response = await axios.post(url, payload ?? null, { headers, timeout: timeoutMs, signal });
      return { status: response.status };
    } catch (error) {
      const status = axios.isAxiosError(error) && error.response ? `HTTP ${error.response.status}` : (error as Error).message;
      throw new Error(`Webhook ${url} failed: ${status}`);
    }
  }
}
