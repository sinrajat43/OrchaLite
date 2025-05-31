export interface Repo {
  id: number;
  name: string;
  stargazers_count: number;
}

export interface FetchReposParams {
  org?: string;
  perPage?: number;
  page?: number;
}

export interface FilterReposParams {
  minStars?: number;
}

export interface StoreReposParams {
  collectionName?: string;
} 