import { filterRepos } from './filterRepos.task';
import { Repo } from './types';

const repos: Repo[] = [
  { id: 1, name: 'none', stargazers_count: 0 },
  { id: 2, name: 'some', stargazers_count: 999 },
  { id: 3, name: 'edge', stargazers_count: 1000 },
  { id: 4, name: 'many', stargazers_count: 50000 },
];

const names = (result: Repo[]) => result.map(repo => repo.name);

describe('filterRepos', () => {
  it('defaults to a 1000 star minimum, inclusive', async () => {
    expect(names(await filterRepos.execute(repos))).toEqual(['edge', 'many']);
  });

  it('uses the given minimum', async () => {
    expect(names(await filterRepos.execute(repos, { minStars: 5000 }))).toEqual(['many']);
  });

  it('treats a minimum of 0 as "keep everything"', async () => {
    expect(await filterRepos.execute(repos, { minStars: 0 })).toHaveLength(4);
  });
});
