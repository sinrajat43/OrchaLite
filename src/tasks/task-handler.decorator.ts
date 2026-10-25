import { DiscoveryService } from '@nestjs/core';

export interface TaskHandlerOptions {
  /** Name a workflow step uses in its `task` field */
  name: string;
  /** Bumped when params or output change incompatibly */
  version: number;
  /** One line for the task catalogue */
  description?: string;
}

/**
 * Marks a provider class as a task. TaskRegistry discovers every provider
 * carrying this metadata when the app starts.
 *
 * @example
 * @TaskHandler({ name: 'http.request', version: 1 })
 * export class HttpRequestTask implements Task<HttpParams, HttpOutput> { ... }
 */
export const TaskHandler = DiscoveryService.createDecorator<TaskHandlerOptions>();
