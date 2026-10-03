import { Task } from './task.interface';
import { getRepoModel } from '../schemas/repo.schema';
import { Repo, StoreReposParams } from './types';

export const storeRepos: Task<Repo[], void, StoreReposParams> = {
  async execute(input: Repo[], params: StoreReposParams = {}): Promise<void> {
    console.log("storeRepos.execute: received input (length):", input.length);
    console.log("storeRepos.execute: attempting to insert (input) into RepoModel...");
    try {
      await getRepoModel(params?.collectionName).create({
        timestamp: new Date(),
        data: input
      });
      console.log("storeRepos.execute: insert (RepoModel.create) succeeded.");
    } catch (error) {
      console.error("storeRepos.execute: insert (RepoModel.create) failed. Error:", error);
      throw new Error(`Failed to store repos: ${error.message}`);
    }
  }
};
