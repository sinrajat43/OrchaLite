import { Controller, Post, Body } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { RunWorkflowDto } from './dto/workflow.dto';
import { WorkflowResults } from '../orchestrator/task-runner.util';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post('run')
  runWorkflow(@Body() dto: RunWorkflowDto): Promise<WorkflowResults> {
    return this.workflowService.run(dto.definition, dto.input);
  }
}
