import { Static, Type } from '@sinclair/typebox';
import { SuspendTask, Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';

const MAX_DELAY_MS = 90 * 24 * 60 * 60 * 1000;

const DelayParamsSchema = Type.Object({ ms: Type.Integer({ minimum: 0, maximum: MAX_DELAY_MS }) }, { additionalProperties: false });
export type DelayParams = Static<typeof DelayParamsSchema>;

const DelayOutputSchema = Type.Object({ waitedMs: Type.Integer() });

@TaskHandler({ name: 'delay', version: 2, description: 'Waits for up to 90 days; the wait is stored, so it survives restarts and uses no worker' })
export class DelayTask implements Task<DelayParams, Static<typeof DelayOutputSchema>> {
  readonly paramsSchema = DelayParamsSchema;
  readonly outputSchema = DelayOutputSchema;

  async execute({ params, resumed }: TaskContext<DelayParams>): Promise<{ waitedMs: number }> {
    if (!resumed) throw new SuspendTask(params.ms);
    return { waitedMs: params.ms };
  }
}
