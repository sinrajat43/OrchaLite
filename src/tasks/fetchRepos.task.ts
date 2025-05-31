import { Task } from './task.interface';
import axios from 'axios';
import { Repo, FetchReposParams } from './types';

export const fetchRepos: Task<void, Repo[], FetchReposParams> = {
  async execute(_input: void, params: FetchReposParams = {}): Promise<Repo[]> {
    const { org = 'github', perPage = 100, page = 1 } = params;
    
    try {
      const response = await axios.get(
        `https://api.github.com/orgs/${org}/repos`,
        {
          params: {
            per_page: perPage,
            page,
            sort: 'stars',
            direction: 'desc'
          },
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            // TODO: Add proper GitHub token handling
            // 'Authorization': `token ${process.env.GITHUB_TOKEN}`
          }
        }
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to fetch repos: ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }
};
  