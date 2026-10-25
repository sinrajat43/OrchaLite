import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { Repo, RepoSchema } from './types';

const FilterReposParamsSchema = Type.Object({
  repos: Type.Array(RepoSchema),
  minStars: Type.Optional(Type.Integer({ minimum: 0, default: 1000 })),
});
export type FilterReposParams = Static<typeof FilterReposParamsSchema>;

@TaskHandler({ name: 'filterRepos', version: 1 })
export class FilterReposTask implements Task<FilterReposParams, Repo[]> {
  readonly paramsSchema = FilterReposParamsSchema;
  readonly outputSchema = Type.Array(RepoSchema);

  async execute({ params }: TaskContext<FilterReposParams>): Promise<Repo[]> {
    const minStars = params.minStars ?? 1000;
    return params.repos.filter(repo => repo.stargazers_count >= minStars);
  }
}
