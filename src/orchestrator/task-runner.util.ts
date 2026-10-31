import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { isTruthy, resolveTemplate, Template } from '../expressions/template';
import { ConnectionLookup, TaskExecutionError, TaskLogger } from '../tasks/task.interface';
import { formatSchemaErrors, validatorFor } from './schema-validator';
import { TaskLookup } from './task-registry.service';
import { CompiledStep, CompiledWorkflow, validateWorkflow, WorkflowDefinition, WorkflowStep } from './workflow-definition';

/** forEach runs items one after another, so keep fan-out bounded until B4 */
export const MAX_FOR_EACH_ITEMS = 1000;

export interface StepResult {
  status: 'succeeded' | 'skipped';
  output?: unknown;
  /** Set on forEach steps: how many items ran */
  iterations?: number;
  /** Set on skipped steps */
  reason?: string;
}

export interface WorkflowResults {
  runId: string;
  steps: Record<string, StepResult>;
}

/**
 * Optional callbacks for observing a run, e.g. to record its history.
 * They are awaited in order, so they must handle their own errors.
 */
export interface RunHooks {
  /** After the definition and input pass their checks, before any step; input has defaults filled in */
  onRunStarted?(input: Record<string, unknown>): Promise<void>;
  onStepStarted?(step: WorkflowStep): Promise<void>;
  /** The step succeeded or was skipped */
  onStepFinished?(step: WorkflowStep, result: StepResult): Promise<void>;
  onStepFailed?(step: WorkflowStep, error: TaskExecutionError): Promise<void>;
}

export interface RunOptions {
  /** Values for the definition's declared input */
  input?: Record<string, unknown>;
  /** Named credentials for tasks; without it, any use of a connection fails */
  connections?: ConnectionLookup;
  /** Defaults to a random UUID */
  runId?: string;
  /** Builds the logger handed to a step; defaults to a Nest Logger */
  createLogger?: (context: string) => TaskLogger;
  /** Called as the run and each step progress */
  hooks?: RunHooks;
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

const noConnections: ConnectionLookup = {
  get: async name => {
    throw new Error(`Connection "${name}" is not available: no connections are configured`);
  },
};

/**
 * The checks a run must pass before it is accepted
 * @returns the input, on a copy, with defaults filled in
 * @throws WorkflowDefinitionError if the definition is invalid
 * @throws RunInputError if the input does not match the declared input
 */
export function checkRun(definition: WorkflowDefinition, tasks: TaskLookup, runInput?: Record<string, unknown>): { compiled: CompiledWorkflow; input: Record<string, unknown> } {
  const compiled = validateWorkflow(definition, tasks);
  const input = structuredClone(runInput ?? {});
  if (!compiled.validateInput(input)) {
    throw new RunInputError(formatSchemaErrors(compiled.validateInput.errors, 'input'));
  }
  return { compiled, input };
}

/**
 * Executes a workflow defined as a DAG of tasks
 * @param definition - Workflow definition
 * @param tasks - Looks up the task each step names
 * @param options - Run input, connections, run id and logger factory
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
  const { compiled, input } = checkRun(definition, tasks, options.input);
  const runId = options.runId ?? randomUUID();
  const createLogger = options.createLogger ?? ((context: string) => new Logger(context));
  const connections = options.connections ?? noConnections;
  const hooks = options.hooks ?? {};

  const results: Record<string, StepResult> = {};

  await hooks.onRunStarted?.(input);
  console.log('Starting workflow execution...');

  async function runStep({ step, params: paramsTemplate, when, forEach, upstream }: CompiledStep): Promise<StepResult> {
    const fail = (message: string, cause?: Error) => new TaskExecutionError(step.id, step.task, message, cause);
    const resolve = async (template: Template, scope: object, path: string) => {
      try {
        return await resolveTemplate(template, scope, path);
      } catch (error) {
        throw fail(`Could not resolve ${path}: ${(error as Error).message}`, error as Error);
      }
    };

    // A skipped dependency produced nothing to work on, so skipping travels downstream
    const skippedDependency = step.dependsOn.find(dep => results[dep].status === 'skipped');
    if (skippedDependency) {
      return { status: 'skipped', reason: `dependency "${skippedDependency}" was skipped` };
    }

    // Expressions see the run input and only the outputs of upstream steps
    const scope = {
      input,
      steps: Object.fromEntries(
        [...upstream].map(id => {
          return [id, { output: results[id].output }];
        })
      ),
    };

    if (when && !isTruthy(await resolve(when, scope, 'when'))) {
      return { status: 'skipped', reason: 'when was false' };
    }

    const task = tasks.get(step.task);
    const validateParams = validatorFor(task.paramsSchema);

    const execute = async (itemScope: object, key: string, label: string) => {
      const params = (await resolve(paramsTemplate, itemScope, 'params')) as Record<string, unknown>;

      // Expressions can produce anything, so check the resolved params; this also fills in defaults
      if (!validateParams(params)) {
        throw fail(`Invalid params${label}: ${formatSchemaErrors(validateParams.errors, 'params').join('; ')}`);
      }

      // TODO: Add timeout and retry logic (B3)
      // Nothing aborts the signal yet; timeouts and cancellation arrive in B3
      try {
        return await task.execute({
          params,
          signal: new AbortController().signal,
          attempt: 1,
          idempotencyKey: key,
          logger: createLogger(`${step.task} run=${runId} step=${step.id}${label}`),
          connections,
        });
      } catch (error) {
        throw fail(`Task execution failed${label}: ${(error as Error)?.message ?? error}`, error as Error);
      }
    };

    if (!forEach) {
      return { status: 'succeeded', output: await execute(scope, `${runId}:${step.id}`, '') };
    }

    // JSONata gives a lone match as a value and no match as undefined; both mean a list here
    const listed = await resolve(forEach, scope, 'forEach');
    const items = listed === undefined ? [] : Array.isArray(listed) ? listed : [listed];
    if (items.length > MAX_FOR_EACH_ITEMS) {
      throw fail(`forEach produced ${items.length} items; the limit is ${MAX_FOR_EACH_ITEMS}`);
    }

    // One item at a time, in order; parallel fan-out comes in B4
    const outputs: unknown[] = [];
    for (const [index, item] of items.entries()) {
      outputs.push(await execute({ ...scope, item, index }, `${runId}:${step.id}:${index}`, ` [item ${index}]`));
    }
    return { status: 'succeeded', output: outputs, iterations: items.length };
  }

  // TODO: Add workflow execution status tracking (B1)

  // Run steps one at a time, each once all of its dependencies have finished
  const pending = [...compiled.steps];
  while (pending.length) {
    const index = pending.findIndex(({ step }) => step.dependsOn.every(dep => dep in results));
    const [next] = pending.splice(index, 1);
    const { step } = next;

    console.log(`Starting task execution: ${step.task} (${step.id})`);
    await hooks.onStepStarted?.(step);
    try {
      results[step.id] = await runStep(next);
    } catch (error) {
      console.error(`Task execution failed: ${step.task} (${step.id})`, error);
      await hooks.onStepFailed?.(
        step,
        error instanceof TaskExecutionError ? error : new TaskExecutionError(step.id, step.task, String((error as Error)?.message ?? error), error as Error)
      );
      throw error;
    }
    console.log(`Finished task execution: ${step.task} (${step.id}): ${results[step.id].status}`);
    await hooks.onStepFinished?.(step, results[step.id]);
  }

  console.log('Workflow execution completed successfully');
  return { runId, steps: results };
}
