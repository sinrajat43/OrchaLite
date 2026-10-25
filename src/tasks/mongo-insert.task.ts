import mongoose from 'mongoose';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { CollectionName } from './mongo-filter';

const MongoInsertParamsSchema = Type.Object(
  {
    collection: CollectionName,
    documents: Type.Union([Type.Object({}), Type.Array(Type.Object({}), { minItems: 1 })], {
      description: 'One document or a non-empty array of them',
    }),
    timestampField: Type.Optional(
      Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'Field set to the insert time on each document' })
    ),
  },
  { additionalProperties: false }
);
export type MongoInsertParams = Static<typeof MongoInsertParamsSchema>;

const MongoInsertOutputSchema = Type.Object({ insertedCount: Type.Integer() });
export type MongoInsertOutput = Static<typeof MongoInsertOutputSchema>;

@TaskHandler({ name: 'mongo.insert', version: 1, description: 'Inserts documents into a MongoDB collection' })
export class MongoInsertTask implements Task<MongoInsertParams, MongoInsertOutput> {
  readonly paramsSchema = MongoInsertParamsSchema;
  readonly outputSchema = MongoInsertOutputSchema;

  async execute({ params, logger }: TaskContext<MongoInsertParams>): Promise<MongoInsertOutput> {
    const { db } = mongoose.connection;
    if (!db) throw new Error('MongoDB is not connected');

    const now = new Date();
    const documents = ([] as Record<string, unknown>[])
      .concat(params.documents as Record<string, unknown>[])
      .map(document => (params.timestampField ? { ...document, [params.timestampField]: now } : { ...document }));

    const result = await db.collection(params.collection).insertMany(documents);
    logger.log(`Inserted ${result.insertedCount} documents into ${params.collection}`);
    return { insertedCount: result.insertedCount };
  }
}
