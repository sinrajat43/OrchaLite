import { Module } from '@nestjs/common';
import { FetchReposTask } from './fetchRepos.task';
import { FilterReposTask } from './filterRepos.task';
import { StoreReposTask } from './storeRepos.task';

/**
 * The built-in task catalogue. A task is any provider marked with
 * @TaskHandler; listing it here is all the registration it needs.
 */
@Module({
  providers: [FetchReposTask, FilterReposTask, StoreReposTask],
})
export class TasksModule {}
