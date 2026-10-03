import { Controller, Get, Post, Body } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { WorkflowResults } from '../orchestrator/task-runner.util';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get('tasks')
  listTasks(): string[] {
    return this.workflowService.listTasks();
  }

  @Post('run')
  runWorkflow(@Body() dto: CreateWorkflowDto): Promise<WorkflowResults> {
    return this.workflowService.run(dto);
  }
}
