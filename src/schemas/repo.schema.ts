import { Schema, model, models } from 'mongoose';

const RepoSchema = new Schema({
  timestamp: Date,
  data: Array,
});

export const RepoModel = model('Repo', RepoSchema);

const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Returns the repo model bound to the given collection (default collection if omitted)
 */
export function getRepoModel(collectionName?: string): typeof RepoModel {
  if (!collectionName) return RepoModel;

  if (!COLLECTION_NAME_PATTERN.test(collectionName)) {
    throw new Error(`Invalid collection name "${collectionName}"`);
  }

  const modelName = `Repo:${collectionName}`;
  return (models[modelName] as typeof RepoModel) ?? model(modelName, RepoSchema, collectionName);
}
