import { Controller, Get, Post, Body, Res } from '@nestjs/common';
import { Response } from 'express';
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
  runWorkflow(
    @Body() dto: CreateWorkflowDto,
    @Res({ passthrough: true }) res: Response
  ): Promise<WorkflowResults> {
    // Set as soon as the run is recorded, so failed runs carry it too
    return this.workflowService.run(dto, runId => res.setHeader('X-Run-Id', runId));
  }
}
