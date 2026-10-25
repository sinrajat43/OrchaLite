import { Type } from '@sinclair/typebox';
import { Task, TaskContext, TaskLogger } from '../tasks/task.interface';

export const silentLogger: TaskLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Builds the context the engine would hand a task for a first attempt
 */
export function contextFor<TParams>(params: TParams): TaskContext<TParams> {
  return {
    params,
    signal: new AbortController().signal,
    attempt: 1,
    idempotencyKey: 'test-run:test-step',
    logger: silentLogger,
  };
}

/**
 * A task with permissive schemas, for engine tests that only care about execute()
 */
export function fakeTask(execute: Task['execute']): Task {
  return { paramsSchema: Type.Any(), outputSchema: Type.Any(), execute };
}
