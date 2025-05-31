import { Injectable, BadRequestException } from '@nestjs/common';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { runWorkflow, WorkflowResults } from '../orchestrator/task-runner.util';
import { taskRegistry } from '../tasks/task-registry';
import { validate } from 'class-validator';
import { plainToClass } from 'class-transformer';

@Injectable()
export class WorkflowService {
  async run(createWorkflowDto: CreateWorkflowDto): Promise<WorkflowResults> {
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

      console.log(`Starting workflow: ${workflowDto.name}`);
      const results = await runWorkflow(workflowDto.steps, taskRegistry);
      console.log(`Completed workflow: ${workflowDto.name}`);
      
      return results;
    } catch (error) {
      console.error('Workflow execution failed:', error);
      throw error;
    }
  }
}
