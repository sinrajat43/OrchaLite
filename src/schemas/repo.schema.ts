import { Schema, model } from 'mongoose';

const RepoSchema = new Schema({
  timestamp: Date,
  data: Array,
});

export const RepoModel = model('Repo', RepoSchema);
