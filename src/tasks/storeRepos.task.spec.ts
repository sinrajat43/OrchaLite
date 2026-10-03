import { getRepoModel, RepoModel } from '../schemas/repo.schema';
import { storeRepos } from './storeRepos.task';

describe('getRepoModel', () => {
  it('uses the default repos collection when no name is given', () => {
    expect(getRepoModel()).toBe(RepoModel);
    expect(RepoModel.collection.name).toBe('repos');
  });

  it('binds a model to the named collection and reuses it', () => {
    const model = getRepoModel('microsoft-repos');

    expect(model.collection.name).toBe('microsoft-repos');
    expect(getRepoModel('microsoft-repos')).toBe(model);
  });

  it('rejects names outside letters, digits, _ and -', () => {
    expect(() => getRepoModel('system.users')).toThrow('Invalid collection name "system.users"');
    expect(() => getRepoModel('a b')).toThrow('Invalid collection name');
  });
});

describe('storeRepos', () => {
  const repos = [{ id: 1, name: 'a', stargazers_count: 5 }];

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes one timestamped document to the default collection', async () => {
    const create = jest.spyOn(RepoModel, 'create').mockResolvedValue(undefined as any);

    await storeRepos.execute(repos);

    expect(create).toHaveBeenCalledWith({ timestamp: expect.any(Date), data: repos });
  });

  it('writes to the named collection when collectionName is given', async () => {
    const create = jest.spyOn(getRepoModel('other-repos'), 'create').mockResolvedValue(undefined as any);
    const defaultCreate = jest.spyOn(RepoModel, 'create').mockResolvedValue(undefined as any);

    await storeRepos.execute(repos, { collectionName: 'other-repos' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(defaultCreate).not.toHaveBeenCalled();
  });

  it('wraps database errors', async () => {
    jest.spyOn(RepoModel, 'create').mockRejectedValue(new Error('disk full'));

    await expect(storeRepos.execute(repos)).rejects.toThrow('Failed to store repos: disk full');
  });
});
