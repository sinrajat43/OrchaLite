import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { getRepoModel } from '../schemas/repo.schema';
import { Repo, RepoSchema } from './types';

const StoreReposParamsSchema = Type.Object({
  repos: Type.Array(RepoSchema),
  collectionName: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]+$' })),
});
export type StoreReposParams = Static<typeof StoreReposParamsSchema>;

@TaskHandler({ name: 'storeRepos', version: 1 })
export class StoreReposTask implements Task<StoreReposParams, void> {
  readonly paramsSchema = StoreReposParamsSchema;
  // An empty schema, as JSON Schema has no "void"; the step produces no output
  readonly outputSchema = Type.Unsafe<void>({ description: 'No output' });

  async execute({ params, logger }: TaskContext<StoreReposParams>): Promise<void> {
    logger.log(`Storing ${params.repos.length} repos`);
    try {
      await getRepoModel(params.collectionName).create({
        timestamp: new Date(),
        data: params.repos
      });
    } catch (error) {
      logger.error(`Insert failed: ${error.message}`);
      throw new Error(`Failed to store repos: ${error.message}`);
    }
  }
}
