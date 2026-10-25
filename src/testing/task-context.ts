import { Type } from '@sinclair/typebox';
import { ConnectionLookup, HttpConnection, Task, TaskContext, TaskLogger } from '../tasks/task.interface';

export const silentLogger: TaskLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Serves the given connections by name */
export const connectionsOf = (...connections: HttpConnection[]): ConnectionLookup => ({
  get: async name => {
    const found = connections.find(c => c.name === name);
    if (!found) throw new Error(`Unknown connection "${name}"`);
    return found;
  },
});

/**
 * Builds the context the engine would hand a task for a first attempt
 */
export function contextFor<TParams>(params: TParams, connections = connectionsOf()): TaskContext<TParams> {
  return {
    params,
    signal: new AbortController().signal,
    attempt: 1,
    idempotencyKey: 'test-run:test-step',
    logger: silentLogger,
    connections,
  };
}

/**
 * A task with permissive schemas, for engine tests that only care about execute()
 */
export function fakeTask(execute: Task['execute']): Task {
  return { paramsSchema: Type.Any(), outputSchema: Type.Any(), execute };
}
