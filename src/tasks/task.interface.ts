/**
 * Interface defining the structure of a task in OrchaLite
 * @template TInput - Type of input data the task accepts
 * @template TOutput - Type of output data the task produces
 * @template TParams - Type of parameters the task accepts (optional)
 */
export interface Task<TInput = any, TOutput = any, TParams = any> {
  /**
   * Execute the task with given input and parameters
   * @param input - Input data from previous tasks or initial input
   * @param params - Optional parameters for task configuration
   * @returns Promise resolving to task output
   * @throws TaskExecutionError if task execution fails
   */
  execute(input: TInput, params?: TParams): Promise<TOutput>;
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

// Type for task registry
export type TaskRegistry = {
  [key: string]: Task;
};
  