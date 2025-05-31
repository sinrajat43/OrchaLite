import { Task, TaskExecutionError, TaskRegistry } from '../tasks/task.interface';

export interface WorkflowStep {
  id: string;
  task: string;
  params?: any;
  dependsOn: string[];
}

export interface WorkflowResults {
  [key: string]: any;
}

/**
 * Executes a workflow defined as a DAG of tasks
 * @param steps - Array of workflow steps
 * @param taskRegistry - Registry of available tasks
 * @returns Promise resolving to workflow results
 * @throws TaskExecutionError if workflow execution fails
 */
export async function runWorkflow(
  steps: WorkflowStep[],
  taskRegistry: TaskRegistry
): Promise<WorkflowResults> {
  const results: WorkflowResults = {};
  const visited = new Set<string>();
  const errors: TaskExecutionError[] = [];

  console.log('Starting workflow execution...');

  async function runStep(step: WorkflowStep) {
    if (visited.has(step.id)) return;

    try {
      console.log(`Starting task execution: ${step.task} (${step.id})`);
      
      // TODO: Add timeout handling
      // const timeout = setTimeout(() => {
      //   throw new TaskExecutionError(step.id, step.task, 'Task execution timed out');
      // }, TASK_TIMEOUT_MS);

      const inputs = step.dependsOn.map(depId => {
        if (!results[depId]) {
          throw new TaskExecutionError(
            step.id,
            step.task,
            `Dependency ${depId} not found in results`
          );
        }
        return results[depId];
      });

      const mergedInput = inputs.length === 1 ? inputs[0] : inputs;
      const task = taskRegistry[step.task];

      if (!task) {
        throw new TaskExecutionError(
          step.id,
          step.task,
          `Task ${step.task} not found in registry`
        );
      }

      // TODO: Add retry logic
      // const result = await withRetry(() => task.execute(mergedInput, step.params), {
      //   maxRetries: 3,
      //   backoff: 'exponential'
      // });

      const result = await task.execute(mergedInput, step.params);
      results[step.id] = result;
      visited.add(step.id);

      console.log(`Completed task execution: ${step.task} (${step.id})`);
    } catch (error) {
      const taskError = error instanceof TaskExecutionError
        ? error
        : new TaskExecutionError(step.id, step.task, 'Task execution failed', error as Error);
      
      errors.push(taskError);
      console.error(`Task execution failed: ${step.task} (${step.id})`, taskError);
      throw taskError;
    }
  }

  try {
    const stepMap = Object.fromEntries(steps.map(s => [s.id, s]));
    const queue = steps.filter(s => s.dependsOn.length === 0).map(s => s.id);

    // TODO: Add workflow execution status tracking
    // const workflowStatus = {
    //   id: generateWorkflowId(),
    //   status: 'RUNNING',
    //   startTime: new Date(),
    //   steps: steps.map(s => ({ id: s.id, status: 'PENDING' }))
    // };
    // await updateWorkflowStatus(workflowStatus);

    while (queue.length) {
      const id = queue.shift();
      if (!id) continue;
      
      const step = stepMap[id];
      await runStep(step);

      for (const s of steps) {
        if (s.dependsOn.every(dep => visited.has(dep)) && !visited.has(s.id)) {
          queue.push(s.id);
        }
      }
    }

    // TODO: Update workflow status to COMPLETED
    // await updateWorkflowStatus({
    //   ...workflowStatus,
    //   status: 'COMPLETED',
    //   endTime: new Date()
    // });

    console.log('Workflow execution completed successfully');
    return results;
  } catch (error) {
    // TODO: Update workflow status to FAILED
    // await updateWorkflowStatus({
    //   ...workflowStatus,
    //   status: 'FAILED',
    //   endTime: new Date(),
    //   error: error.message
    // });

    console.error('Workflow execution failed:', error);
    throw error;
  }
}
  