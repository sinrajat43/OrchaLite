import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConnectionsService } from '../connections/connections.service';
import { runWorkflow, RunInputError, WorkflowResults } from '../orchestrator/task-runner.util';
import { TaskRegistry } from '../orchestrator/task-registry.service';
import { validateWorkflow, WorkflowDefinition, WorkflowDefinitionError } from '../orchestrator/workflow-definition';
import { TaskExecutionError } from '../tasks/task.interface';
import { RunRecorder } from '../runs/run-recorder';
import { WorkflowRef } from '../runs/run.types';

/**
 * Maps engine errors to HTTP errors
 * @param runId - Added to a failed step's error so the run can be looked up in /runs
 */
export function toHttpError(error: unknown, runId?: string): unknown {
  if (error instanceof WorkflowDefinitionError) {
    return new BadRequestException({ message: 'Invalid workflow definition', errors: error.issues });
  }
  if (error instanceof RunInputError) {
    return new BadRequestException({ message: 'Invalid run input', errors: error.issues });
  }
  if (error instanceof TaskExecutionError) {
    return new InternalServerErrorException({
      message: error.message,
      stepId: error.taskId,
      task: error.taskName,
      ...(runId ? { runId } : {}),
    });
  }
  return error;
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly tasks: TaskRegistry,
    private readonly connections: ConnectionsService,
    private readonly runRecorder: RunRecorder
  ) {}

  /**
   * @throws BadRequestException listing every problem with the definition
   */
  validate(definition: WorkflowDefinition): void {
    try {
      validateWorkflow(definition, this.tasks);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  /**
   * Runs a workflow and records it in the run history
   * @param workflow - The stored version the definition came from, if any
   */
  async run(definition: WorkflowDefinition, input?: Record<string, unknown>, workflow?: WorkflowRef): Promise<WorkflowResults> {
    // Records nothing until the engine accepts the definition and input
    const run = this.runRecorder.prepare(definition, workflow);
    try {
      console.log(`Starting workflow: ${definition.name} (run ${run.runId})`);
      const results = await runWorkflow(definition, this.tasks, {
        input,
        connections: this.connections,
        runId: run.runId,
        hooks: run.hooks,
      });
      await run.succeed();
      console.log(`Completed workflow: ${definition.name} (run ${run.runId})`);
      return results;
    } catch (error) {
      console.error('Workflow execution failed:', error);
      await run.fail(error as Error);
      throw toHttpError(error, run.started ? run.runId : undefined);
    }
  }
}
