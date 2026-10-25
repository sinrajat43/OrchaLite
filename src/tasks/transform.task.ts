import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';

const TransformParamsSchema = Type.Object(
  { value: Type.Unknown({ description: 'Usually {{ ... }} expressions that reshape earlier outputs' }) },
  { additionalProperties: false }
);
export type TransformParams = Static<typeof TransformParamsSchema>;

@TaskHandler({
  name: 'transform',
  version: 1,
  description: 'Returns `value` once its expressions are resolved, to reshape data between steps',
})
export class TransformTask implements Task<TransformParams, unknown> {
  readonly paramsSchema = TransformParamsSchema;
  readonly outputSchema = Type.Unknown();

  async execute({ params }: TaskContext<TransformParams>): Promise<unknown> {
    return params.value;
  }
}
