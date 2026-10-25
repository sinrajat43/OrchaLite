import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { runWorkflow, validateWorkflow, WorkflowDefinitionError, WorkflowResults } from '../orchestrator/task-runner.util';
import { RunRecorder } from '../runs/run-recorder';
import { taskRegistry } from '../tasks/task-registry';
import { TaskExecutionError } from '../tasks/task.interface';
import { validate } from 'class-validator';
import { plainToClass } from 'class-transformer';

@Injectable()
export class WorkflowService {
  constructor(private readonly runRecorder: RunRecorder) {}

  listTasks(): string[] {
    return Object.keys(taskRegistry);
  }

  /**
   * Runs a workflow and records it in the run history
   * @param onRunCreated - Called with the run id once the run is recorded, before any step runs
   */
  async run(
    createWorkflowDto: CreateWorkflowDto,
    onRunCreated?: (runId: string) => void
  ): Promise<WorkflowResults> {
    let runId: string | undefined;

    try {
      // Validate DTO
      const workflowDto = plainToClass(CreateWorkflowDto, createWorkflowDto);
      const errors = await validate(workflowDto);
      
      if (errors.length > 0) {
        throw new BadRequestException({
          message: 'Workflow validation failed',
          errors: errors.map(error => ({
            property: error.property,
            constraints: error.constraints
          }))
        });
      }

      // Validate that all tasks exist in registry
      const missingTasks = workflowDto.steps
        .filter(step => !taskRegistry[step.task])
        .map(step => step.task);

      if (missingTasks.length > 0) {
        throw new BadRequestException({
          message: 'Invalid tasks in workflow',
          missingTasks
        });
      }

      // Rejected definitions are not runs, so validate before recording one
      validateWorkflow(workflowDto.steps);

      const run = await this.runRecorder.start({ name: workflowDto.name, steps: workflowDto.steps });
      runId = run.runId;
      onRunCreated?.(runId);

      console.log(`Starting workflow: ${workflowDto.name} (run ${runId})`);
      let results: WorkflowResults;
      try {
        results = await runWorkflow(workflowDto.steps, taskRegistry, run.hooks);
      } catch (error) {
        await run.fail(error as Error);
        throw error;
      }
      await run.succeed();
      console.log(`Completed workflow: ${workflowDto.name} (run ${runId})`);
      
      return results;
    } catch (error) {
      console.error('Workflow execution failed:', error);

      if (error instanceof WorkflowDefinitionError) {
        throw new BadRequestException({
          message: 'Invalid workflow definition',
          errors: error.issues
        });
      }

      if (error instanceof TaskExecutionError) {
        throw new InternalServerErrorException({
          message: error.message,
          stepId: error.taskId,
          task: error.taskName,
          runId
        });
      }

      throw error;
    }
  }
}
