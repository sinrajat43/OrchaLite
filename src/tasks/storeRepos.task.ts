import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { getRepoModel } from '../schemas/repo.schema';
import { Repo } from './types';

const StoreReposParamsSchema = Type.Object({
  collectionName: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]+$' })),
});
export type StoreReposParams = Static<typeof StoreReposParamsSchema>;

@TaskHandler({ name: 'storeRepos', version: 1 })
export class StoreReposTask implements Task<StoreReposParams, void, Repo[]> {
  readonly paramsSchema = StoreReposParamsSchema;
  // An empty schema, as JSON Schema has no "void"; the step produces no output
  readonly outputSchema = Type.Unsafe<void>({ description: 'No output' });

  async execute({ params, input, logger }: TaskContext<StoreReposParams, Repo[]>): Promise<void> {
    logger.log(`Storing ${input.length} repos`);
    try {
      await getRepoModel(params?.collectionName).create({
        timestamp: new Date(),
        data: input
      });
    } catch (error) {
      logger.error(`Insert failed: ${error.message}`);
      throw new Error(`Failed to store repos: ${error.message}`);
    }
  }
}
