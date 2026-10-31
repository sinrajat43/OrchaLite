import { Controller, Post, Body, HttpCode, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AcceptedRun, WorkflowService } from './workflow.service';
import { RunWorkflowDto } from './dto/workflow.dto';
import { RunResult } from '../runs/run-result';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post('run')
  @HttpCode(202)
  async runWorkflow(
    @Body() dto: RunWorkflowDto,
    @Query('wait') wait: string | undefined,
    @Res({ passthrough: true }) response: Response
  ): Promise<AcceptedRun | RunResult> {
    const accepted = await this.workflowService.start(dto.definition, dto.input);
    return this.workflowService.respond(accepted, wait, response);
  }
}
