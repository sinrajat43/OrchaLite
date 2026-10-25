import { Type } from '@sinclair/typebox';

/**
 * Equality-only filter: field names may not start with $ and values are
 * scalars, so data from an expression cannot become a query operator such as
 * $where or $gt.
 */
export const EqualityFilter = Type.Record(
  Type.String({ pattern: '^[^$]' }),
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
  { additionalProperties: false, description: 'Field equality only, e.g. { "repo": "nestjs/nest" }' }
);

export const CollectionName = Type.String({ pattern: '^[A-Za-z0-9_-]+$', description: 'Letters, digits, _ and -' });
