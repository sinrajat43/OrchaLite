import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConnectionsService } from '../connections/connections.service';
import { runWorkflow, RunInputError, WorkflowResults } from '../orchestrator/task-runner.util';
import { TaskRegistry } from '../orchestrator/task-registry.service';
import { validateWorkflow, WorkflowDefinition, WorkflowDefinitionError } from '../orchestrator/workflow-definition';
import { TaskExecutionError } from '../tasks/task.interface';

/**
 * Maps engine errors to HTTP errors
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof WorkflowDefinitionError) {
    return new BadRequestException({ message: 'Invalid workflow definition', errors: error.issues });
  }
  if (error instanceof RunInputError) {
    return new BadRequestException({ message: 'Invalid run input', errors: error.issues });
  }
  if (error instanceof TaskExecutionError) {
    return new InternalServerErrorException({ message: error.message, stepId: error.taskId, task: error.taskName });
  }
  return error;
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly tasks: TaskRegistry,
    private readonly connections: ConnectionsService
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

  async run(definition: WorkflowDefinition, input?: Record<string, unknown>): Promise<WorkflowResults> {
    try {
      console.log(`Starting workflow: ${definition.name}`);
      const results = await runWorkflow(definition, this.tasks, { input, connections: this.connections });
      console.log(`Completed workflow: ${definition.name}`);
      return results;
    } catch (error) {
      console.error('Workflow execution failed:', error);
      throw toHttpError(error);
    }
  }
}
