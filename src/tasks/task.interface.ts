import { LoggerService } from '@nestjs/common';
import { TSchema } from '@sinclair/typebox';

export type TaskLogger = Pick<LoggerService, 'log' | 'warn' | 'error' | 'debug'>;

/** Named credentials for HTTP calls, decrypted only when a step asks for them */
export interface HttpConnection {
  name: string;
  type: 'http';
  /** Credentials are only ever sent to URLs under this one */
  baseUrl: string;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface ConnectionLookup {
  /** @throws Error if there is no connection with this name */
  get(name: string): Promise<HttpConnection>;
}

/**
 * Everything the engine hands a task for one execution of one step
 * @template TParams - Type of the step's params
 */
export interface TaskContext<TParams = unknown> {
  /** Params from the step definition, with every {{ ... }} expression resolved */
  params: TParams;
  /** Aborted on timeout or cancellation */
  signal: AbortSignal;
  /** 1-based attempt number */
  attempt: number;
  /** Stable per run + step, so a retried side effect can be deduplicated */
  idempotencyKey: string;
  /** Tagged with the run id and step id */
  logger: TaskLogger;
  /** Named credentials; definitions refer to them by name and never hold secrets */
  connections: ConnectionLookup;
  /** True when this execution follows a SuspendTask, once the wait is over */
  resumed?: boolean;
}

/**
 * A unit of work a workflow step can run. Implementations are classes marked
 * with @TaskHandler and registered as Nest providers; the engine finds them
 * through discovery, so adding a task never changes engine code.
 * @template TParams - Type of parameters the task accepts
 * @template TOutput - Type of output data the task produces
 */
export interface Task<TParams = any, TOutput = any> {
  /** JSON Schema of the step's params */
  readonly paramsSchema: TSchema;
  /** JSON Schema of the output, so later steps can be checked against it */
  readonly outputSchema: TSchema;

  /**
   * Checks beyond the schema, run at submit time on the step's params as
   * written, so values may still be {{ ... }} expressions
   * @returns problems found, each starting with the param path
   */
  validate?(params: Record<string, unknown>): string[];

  /**
   * Execute the task for one step
   * @returns Promise resolving to the step's output
   * @throws Error if the task fails; the engine wraps it in TaskExecutionError
   */
  execute(ctx: TaskContext<TParams>): Promise<TOutput>;
}

/**
 * Thrown by a task that wants to wait. The worker frees its slot and the job is
 * delivered again after the wait, with ctx.resumed set. The wait is a timestamp
 * in the database, so it survives restarts and holds nothing in memory.
 */
export class SuspendTask extends Error {
  constructor(public readonly ms: number) {
    super(`Suspended for ${ms} ms`);
    this.name = 'SuspendTask';
  }
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
