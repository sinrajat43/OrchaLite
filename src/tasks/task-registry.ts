import { fetchRepos } from './fetchRepos.task';
import { filterRepos } from './filterRepos.task';
import { storeRepos } from './storeRepos.task';

export const taskRegistry = {
  fetchRepos,
  filterRepos,
  storeRepos,
};
