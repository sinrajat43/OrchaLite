import { Task } from './task.interface';
import { Repo, FilterReposParams } from './types';

export const filterRepos: Task<Repo[], Repo[], FilterReposParams> = {
  async execute(input: Repo[], params: FilterReposParams = {}): Promise<Repo[]> {
    const minStars = params?.minStars || 1000;
    return input.filter(repo => repo.stargazers_count >= minStars);
  }
};
  