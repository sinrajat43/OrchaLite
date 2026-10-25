import mongoose from 'mongoose';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { CollectionName, EqualityFilter } from './mongo-filter';

const MongoFindOneParamsSchema = Type.Object(
  { collection: CollectionName, filter: EqualityFilter },
  { additionalProperties: false }
);
export type MongoFindOneParams = Static<typeof MongoFindOneParamsSchema>;

@TaskHandler({
  name: 'mongo.findOne',
  version: 1,
  description: 'Reads one document matching an equality filter, or null (without _id)',
})
export class MongoFindOneTask implements Task<MongoFindOneParams, Record<string, unknown> | null> {
  readonly paramsSchema = MongoFindOneParamsSchema;
  readonly outputSchema = Type.Union([Type.Object({}), Type.Null()]);

  async execute({ params }: TaskContext<MongoFindOneParams>): Promise<Record<string, unknown> | null> {
    const { db } = mongoose.connection;
    if (!db) throw new Error('MongoDB is not connected');
    // _id is an ObjectId, which is not JSON; leave it out so outputs stay plain data
    return db.collection(params.collection).findOne(params.filter, { projection: { _id: 0 } });
  }
}
