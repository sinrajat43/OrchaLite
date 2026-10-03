import { Task } from './task.interface';
import axios from 'axios';
import { Repo, FetchReposParams } from './types';

export const fetchRepos: Task<void, Repo[], FetchReposParams> = {
  async execute(_input: void, params: FetchReposParams = {}): Promise<Repo[]> {
    const { org = 'github', perPage = 100, page = 1 } = params;

    // The org goes into a search query, so reject anything that could add qualifiers
    if (!/^[A-Za-z0-9-]+$/.test(org)) {
      throw new Error(`Invalid GitHub organization name "${org}"`);
    }

    try {
      // The org repos endpoint cannot sort by stars; the search API can
      const response = await axios.get(
        'https://api.github.com/search/repositories',
        {
          params: {
            q: `org:${org}`,
            per_page: perPage,
            page,
            sort: 'stars',
            order: 'desc'
          },
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN
              ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
              : {})
          }
        }
      );

      return response.data.items;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to fetch repos: ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }
};
  