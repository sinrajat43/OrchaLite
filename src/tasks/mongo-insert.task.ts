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

  async execute({ params, logger, idempotencyKey }: TaskContext<MongoInsertParams>): Promise<MongoInsertOutput> {
    const { db } = mongoose.connection;
    if (!db) throw new Error('MongoDB is not connected');

    const now = new Date();
    const documents = ([] as Record<string, unknown>[])
      .concat(params.documents as Record<string, unknown>[])
      .map(document => (params.timestampField ? { ...document, [params.timestampField]: now } : { ...document }));

    // An id derived from the step means a repeat of this step cannot insert the document again
    const generated = new Set<number>();
    const keyed = documents.map((document, index) => {
      if ('_id' in document) return document;
      generated.add(index);
      return { ...document, _id: `${idempotencyKey}:${index}` };
    }) as any[];

    try {
      const result = await db.collection(params.collection).insertMany(keyed, { ordered: false });
      logger.log(`Inserted ${result.insertedCount} documents into ${params.collection}`);
    } catch (error) {
      // Documents an earlier try inserted are fine; anything else is a real failure
      const failures = [].concat((error as any)?.writeErrors ?? []);
      const onlyRepeats = (error as any)?.code === 11000 && failures.every(f => f.code === 11000 && generated.has(f.index));
      if (!onlyRepeats) throw error;
      logger.log(`Found ${failures.length} of ${documents.length} documents already inserted into ${params.collection} by an earlier try`);
    }
    return { insertedCount: documents.length };
  }
}
