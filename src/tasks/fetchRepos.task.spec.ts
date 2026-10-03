import axios, { AxiosError } from 'axios';
import { fetchRepos } from './fetchRepos.task';

describe('fetchRepos', () => {
  const items = [{ id: 1, name: 'a', stargazers_count: 5 }];
  let get: jest.SpyInstance;
  const savedToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    get = jest.spyOn(axios, 'get').mockResolvedValue({ data: { total_count: 1, items } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  it('searches the org sorted by stars and returns the items', async () => {
    const result = await fetchRepos.execute(undefined, { org: 'microsoft', perPage: 50, page: 2 });

    expect(result).toBe(items);
    const [url, config] = get.mock.calls[0];
    expect(url).toBe('https://api.github.com/search/repositories');
    expect(config.params).toEqual({ q: 'org:microsoft', per_page: 50, page: 2, sort: 'stars', order: 'desc' });
  });

  it('defaults to the github org, 100 per page, first page', async () => {
    await fetchRepos.execute(undefined);

    expect(get.mock.calls[0][1].params).toMatchObject({ q: 'org:github', per_page: 100, page: 1 });
  });

  it('sends the token only when GITHUB_TOKEN is set', async () => {
    await fetchRepos.execute(undefined);
    expect(get.mock.calls[0][1].headers).not.toHaveProperty('Authorization');

    process.env.GITHUB_TOKEN = 'abc';
    await fetchRepos.execute(undefined);
    expect(get.mock.calls[1][1].headers.Authorization).toBe('token abc');
  });

  it('rejects org names that could add search qualifiers, without calling GitHub', async () => {
    await expect(fetchRepos.execute(undefined, { org: 'microsoft stars:>1' })).rejects.toThrow(
      'Invalid GitHub organization name'
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("surfaces GitHub's error message", async () => {
    const error = new AxiosError('Request failed with status code 422');
    error.response = { data: { message: 'Validation Failed' } } as any;
    get.mockRejectedValue(error);

    await expect(fetchRepos.execute(undefined, { org: 'nope' })).rejects.toThrow(
      'Failed to fetch repos: Validation Failed'
    );
  });
});
