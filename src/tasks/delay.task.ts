import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';

// The wait holds an HTTP request open until runs move off the request in B1-B2
const MAX_DELAY_MS = 60_000;

const DelayParamsSchema = Type.Object({ ms: Type.Integer({ minimum: 0, maximum: MAX_DELAY_MS }) }, { additionalProperties: false });
export type DelayParams = Static<typeof DelayParamsSchema>;

const DelayOutputSchema = Type.Object({ waitedMs: Type.Integer() });

@TaskHandler({ name: 'delay', version: 1, description: 'Waits for up to 60 seconds, in process (durable waits come in B2)' })
export class DelayTask implements Task<DelayParams, Static<typeof DelayOutputSchema>> {
  readonly paramsSchema = DelayParamsSchema;
  readonly outputSchema = DelayOutputSchema;

  execute({ params, signal }: TaskContext<DelayParams>): Promise<{ waitedMs: number }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('Delay aborted'));
      const timer = setTimeout(() => resolve({ waitedMs: params.ms }), params.ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Delay aborted'));
      }, { once: true });
    });
  }
}
