import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { RunWorkflowDto } from './dto/workflow.dto';
import { runWorkflow, RunInputError, WorkflowResults } from '../orchestrator/task-runner.util';
import { TaskRegistry } from '../orchestrator/task-registry.service';
import { WorkflowDefinitionError } from '../orchestrator/workflow-definition';
import { TaskExecutionError } from '../tasks/task.interface';

@Injectable()
export class WorkflowService {
  constructor(private readonly tasks: TaskRegistry) {}

  listTasks(): string[] {
    return this.tasks.names();
  }

  async run({ definition, input }: RunWorkflowDto): Promise<WorkflowResults> {
    try {
      console.log(`Starting workflow: ${definition.name}`);
      const results = await runWorkflow(definition, this.tasks, { input });
      console.log(`Completed workflow: ${definition.name}`);

      return results;
    } catch (error) {
      console.error('Workflow execution failed:', error);

      if (error instanceof WorkflowDefinitionError) {
        throw new BadRequestException({
          message: 'Invalid workflow definition',
          errors: error.issues
        });
      }

      if (error instanceof RunInputError) {
        throw new BadRequestException({
          message: 'Invalid run input',
          errors: error.issues
        });
      }

      if (error instanceof TaskExecutionError) {
        throw new InternalServerErrorException({
          message: error.message,
          stepId: error.taskId,
          task: error.taskName
        });
      }

      throw error;
    }
  }
}
