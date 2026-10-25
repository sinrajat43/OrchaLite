import axios from 'axios';
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';
import { Repo, RepoSchema } from './types';

const FetchReposParamsSchema = Type.Object({
  org: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9-]+$', default: 'github' })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 100 })),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
});
export type FetchReposParams = Static<typeof FetchReposParamsSchema>;

@TaskHandler({ name: 'fetchRepos', version: 1 })
export class FetchReposTask implements Task<FetchReposParams, Repo[]> {
  readonly paramsSchema = FetchReposParamsSchema;
  readonly outputSchema = Type.Array(RepoSchema);

  async execute({ params, signal }: TaskContext<FetchReposParams>): Promise<Repo[]> {
    const { org = 'github', perPage = 100, page = 1 } = params ?? {};

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
          },
          signal
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
}
