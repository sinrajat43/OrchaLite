import { Module } from '@nestjs/common';
import { DelayTask } from './delay.task';
import { FilterTask } from './filter.task';
import { HttpRequestTask } from './http-request.task';
import { MongoInsertTask } from './mongo-insert.task';
import { NotifyWebhookTask } from './notify-webhook.task';
import { TransformTask } from './transform.task';

/**
 * The built-in task catalogue. A task is any provider marked with
 * @TaskHandler; listing it here is all the registration it needs.
 */
@Module({
  providers: [HttpRequestTask, TransformTask, FilterTask, MongoInsertTask, NotifyWebhookTask, DelayTask],
})
export class TasksModule {}
