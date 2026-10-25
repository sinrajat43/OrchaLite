import { Module } from '@nestjs/common';
import { DelayTask } from './delay.task';
import { FilterTask } from './filter.task';
import { HttpRequestTask } from './http-request.task';
import { MongoFindOneTask } from './mongo-find-one.task';
import { MongoInsertTask } from './mongo-insert.task';
import { MongoUpsertTask } from './mongo-upsert.task';
import { NotifyWebhookTask } from './notify-webhook.task';
import { TransformTask } from './transform.task';

/**
 * The built-in task catalogue. A task is any provider marked with
 * @TaskHandler; listing it here is all the registration it needs.
 */
@Module({
  providers: [
    HttpRequestTask,
    TransformTask,
    FilterTask,
    MongoInsertTask,
    MongoFindOneTask,
    MongoUpsertTask,
    NotifyWebhookTask,
    DelayTask,
  ],
})
export class TasksModule {}
