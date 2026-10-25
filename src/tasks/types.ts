import { Static, Type } from '@sinclair/typebox';

// GitHub returns many more fields; these are the ones tasks rely on
export const RepoSchema = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    stargazers_count: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: true }
);
export type Repo = Static<typeof RepoSchema>;
