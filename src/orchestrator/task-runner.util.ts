import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { resolveTemplate } from '../expressions/template';
import { TaskExecutionError, TaskLogger } from '../tasks/task.interface';
import { formatSchemaErrors, validatorFor } from './schema-validator';
import { TaskLookup } from './task-registry.service';
import { CompiledStep, validateWorkflow, WorkflowDefinition } from './workflow-definition';

export interface StepResult {
  status: 'succeeded';
  output?: unknown;
}

export interface WorkflowResults {
  runId: string;
  steps: Record<string, StepResult>;
}

export interface RunOptions {
  /** Values for the definition's declared input */
  input?: Record<string, unknown>;
  /** Defaults to a random UUID */
  runId?: string;
  /** Builds the logger handed to a step; defaults to a Nest Logger */
  createLogger?: (context: string) => TaskLogger;
}

/**
 * Error thrown when run input does not match the definition's declared input
 */
export class RunInputError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid run input: ${issues.join('; ')}`);
    this.name = 'RunInputError';
  }
}

/**
 * Executes a workflow defined as a DAG of tasks
 * @param definition - Workflow definition
 * @param tasks - Looks up the task each step names
 * @param options - Run input, run id and logger factory
 * @returns Promise resolving to every step's result
 * @throws WorkflowDefinitionError if the definition is invalid
 * @throws RunInputError if the input does not match the declared input
 * @throws TaskExecutionError if a step fails
 */
export async function runWorkflow(
  definition: WorkflowDefinition,
  tasks: TaskLookup,
  options: RunOptions = {}
): Promise<WorkflowResults> {
  const compiled = validateWorkflow(definition, tasks);
  const runId = options.runId ?? randomUUID();
  const createLogger = options.createLogger ?? ((context: string) => new Logger(context));

  // Validation fills in defaults, so work on a copy of the caller's input
  const input = structuredClone(options.input ?? {});
  if (!compiled.validateInput(input)) {
    throw new RunInputError(formatSchemaErrors(compiled.validateInput.errors, 'input'));
  }

  const results: Record<string, StepResult> = {};

  console.log('Starting workflow execution...');

  async function runStep({ step, params: paramsTemplate, upstream }: CompiledStep) {
    try {
      console.log(`Starting task execution: ${step.task} (${step.id})`);

      // TODO: Add timeout handling
      // const timeout = setTimeout(() => {
      //   throw new TaskExecutionError(step.id, step.task, 'Task execution timed out');
      // }, TASK_TIMEOUT_MS);

      // Expressions see the run input and only the outputs of upstream steps
      const scope = {
        input,
        steps: Object.fromEntries([...upstream].map(id => [id, { output: results[id].output }])),
      };

      let params: Record<string, unknown>;
      try {
        params = (await resolveTemplate(paramsTemplate, scope, 'params')) as Record<string, unknown>;
      } catch (error) {
        throw new TaskExecutionError(step.id, step.task, `Could not resolve params: ${(error as Error).message}`, error as Error);
      }

      const task = tasks.get(step.task);

      // Expressions can produce anything, so check the resolved params; this also fills in defaults
      const validateParams = validatorFor(task.paramsSchema);
      if (!validateParams(params)) {
        throw new TaskExecutionError(
          step.id,
          step.task,
          `Invalid params: ${formatSchemaErrors(validateParams.errors, 'params').join('; ')}`
        );
      }

      // TODO: Add retry logic
      // const result = await withRetry(() => task.execute(...), {
      //   maxRetries: 3,
      //   backoff: 'exponential'
      // });

      // Nothing aborts the signal yet; timeouts and cancellation arrive in B3
      const output = await task.execute({
        params,
        signal: new AbortController().signal,
        attempt: 1,
        idempotencyKey: `${runId}:${step.id}`,
        logger: createLogger(`${step.task} run=${runId} step=${step.id}`),
      });
      results[step.id] = { status: 'succeeded', output };

      console.log(`Completed task execution: ${step.task} (${step.id})`);
    } catch (error) {
      const taskError = error instanceof TaskExecutionError
        ? error
        : new TaskExecutionError(
            step.id,
            step.task,
            `Task execution failed: ${(error as Error)?.message ?? error}`,
            error as Error
          );

      console.error(`Task execution failed: ${step.task} (${step.id})`, taskError);
      throw taskError;
    }
  }

  // TODO: Add workflow execution status tracking
  // const workflowStatus = {
  //   id: runId,
  //   status: 'RUNNING',
  //   startTime: new Date(),
  //   steps: steps.map(s => ({ id: s.id, status: 'PENDING' }))
  // };
  // await updateWorkflowStatus(workflowStatus);

  // Run steps one at a time, each once all of its dependencies have finished
  const pending = [...compiled.steps];
  while (pending.length) {
    const index = pending.findIndex(({ step }) => step.dependsOn.every(dep => dep in results));
    const [next] = pending.splice(index, 1);
    await runStep(next);
  }

  console.log('Workflow execution completed successfully');
  return { runId, steps: results };
}
