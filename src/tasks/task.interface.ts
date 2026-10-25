import { LoggerService } from '@nestjs/common';
import { TSchema } from '@sinclair/typebox';

export type TaskLogger = Pick<LoggerService, 'log' | 'warn' | 'error' | 'debug'>;

/**
 * Everything the engine hands a task for one execution of one step
 * @template TParams - Type of the step's params
 * @template TInput - Type of the dependencies' outputs
 */
export interface TaskContext<TParams = unknown, TInput = unknown> {
  /** Params from the step definition */
  params: TParams;
  /**
   * Outputs of the step's dependencies, positionally: one dependency gives its
   * output, several give an array. Replaced by expressions in A2.
   */
  input: TInput;
  /** Aborted on timeout or cancellation */
  signal: AbortSignal;
  /** 1-based attempt number */
  attempt: number;
  /** Stable per run + step, so a retried side effect can be deduplicated */
  idempotencyKey: string;
  /** Tagged with the run id and step id */
  logger: TaskLogger;
}

/**
 * A unit of work a workflow step can run. Implementations are classes marked
 * with @TaskHandler and registered as Nest providers; the engine finds them
 * through discovery, so adding a task never changes engine code.
 * @template TParams - Type of parameters the task accepts
 * @template TOutput - Type of output data the task produces
 * @template TInput - Type of input data from dependencies
 */
export interface Task<TParams = any, TOutput = any, TInput = any> {
  /** JSON Schema of the step's params */
  readonly paramsSchema: TSchema;
  /** JSON Schema of the output, so later steps can be checked against it */
  readonly outputSchema: TSchema;

  /**
   * Execute the task for one step
   * @returns Promise resolving to the step's output
   * @throws Error if the task fails; the engine wraps it in TaskExecutionError
   */
  execute(ctx: TaskContext<TParams, TInput>): Promise<TOutput>;
}

/**
 * Custom error class for task execution failures
 */
export class TaskExecutionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly taskName: string,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'TaskExecutionError';
  }
}
