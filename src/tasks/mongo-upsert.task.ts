import mongoose from 'mongoose';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { CollectionName, EqualityFilter } from './mongo-filter';

const MongoUpsertParamsSchema = Type.Object(
  {
    collection: CollectionName,
    filter: EqualityFilter,
    set: Type.Record(Type.String({ pattern: '^[^$]' }), Type.Unknown(), {
      additionalProperties: false,
      description: 'Fields to set; the filter fields are set too when the document is created',
    }),
    timestampField: Type.Optional(
      Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'Field set to the write time' })
    ),
  },
  { additionalProperties: false }
);
export type MongoUpsertParams = Static<typeof MongoUpsertParamsSchema>;

const MongoUpsertOutputSchema = Type.Object({ created: Type.Boolean(), modified: Type.Boolean() });
export type MongoUpsertOutput = Static<typeof MongoUpsertOutputSchema>;

@TaskHandler({
  name: 'mongo.upsert',
  version: 1,
  description: 'Updates the document matching an equality filter, creating it if there is none',
})
export class MongoUpsertTask implements Task<MongoUpsertParams, MongoUpsertOutput> {
  readonly paramsSchema = MongoUpsertParamsSchema;
  readonly outputSchema = MongoUpsertOutputSchema;

  async execute({ params }: TaskContext<MongoUpsertParams>): Promise<MongoUpsertOutput> {
    const { db } = mongoose.connection;
    if (!db) throw new Error('MongoDB is not connected');

    const set = params.timestampField ? { ...params.set, [params.timestampField]: new Date() } : params.set;
    // Setting the same values twice changes nothing, so a retried step is harmless
    const result = await db.collection(params.collection).updateOne(params.filter, { $set: set }, { upsert: true });
    return { created: result.upsertedCount > 0, modified: result.modifiedCount > 0 };
  }
}
