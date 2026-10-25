import jsonata = require('jsonata');
import { Static, Type } from '@sinclair/typebox';
import { isTruthy } from '../expressions/template';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';

const FilterParamsSchema = Type.Object(
  {
    items: Type.Array(Type.Unknown()),
    where: Type.String({
      minLength: 1,
      description: 'JSONata condition evaluated against each item, for example "stargazers_count >= $minStars"',
    }),
    vars: Type.Optional(
      Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), Type.Unknown(), {
        description: 'Values the condition reads as $name; use {{ ... }} here to pass in input or earlier outputs',
      })
    ),
  },
  { additionalProperties: false }
);
export type FilterParams = Static<typeof FilterParamsSchema>;

@TaskHandler({ name: 'filter', version: 1, description: 'Keeps the items for which a JSONata condition holds' })
export class FilterTask implements Task<FilterParams, unknown[]> {
  readonly paramsSchema = FilterParamsSchema;
  readonly outputSchema = Type.Array(Type.Unknown());

  validate(params: Record<string, unknown>): string[] {
    const { where } = params;
    if (typeof where !== 'string') return [];
    // where is code, so splicing values into it would let data change the condition
    if (where.includes('{{')) {
      return ['params.where is evaluated per item; pass values in through vars instead of {{ ... }}'];
    }
    try {
      jsonata(where);
      return [];
    } catch (error) {
      return [`params.where: invalid condition: ${(error as Error).message}`];
    }
  }

  async execute({ params }: TaskContext<FilterParams>): Promise<unknown[]> {
    const condition = jsonata(params.where);
    const kept: unknown[] = [];
    for (const item of params.items) {
      if (isTruthy(await condition.evaluate(item, params.vars))) kept.push(item);
    }
    return kept;
  }
}
