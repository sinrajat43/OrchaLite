import { Controller, Get, Header, Inject, Param, Post, Body, Headers, HttpCode, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AcceptedRun, WorkflowService } from './workflow.service';
import { RunWorkflowDto } from './dto/workflow.dto';
import { RunResult } from '../runs/run-result';
import { TELEMETRY, Telemetry } from '../telemetry/telemetry';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post('run')
  @HttpCode(202)
  async runWorkflow(
    @Body() dto: RunWorkflowDto,
    @Query('wait') wait: string | undefined,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<AcceptedRun | RunResult> {
    const accepted = await this.workflowService.start(dto.definition, dto.input, undefined, idempotencyKey);
    return this.workflowService.respond(accepted, wait, response);
  }
}

@Controller('runs')
export class RunActionsController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post(':id/cancel')
  @HttpCode(202)
  cancel(@Param('id') id: string): Promise<AcceptedRun> {
    return this.workflowService.cancel(id);
  }

  /** Runs a failed or cancelled run again from where it stopped */
  @Post(':id/retry')
  @HttpCode(202)
  retry(@Param('id') id: string): Promise<AcceptedRun> {
    return this.workflowService.retry(id);
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(TELEMETRY) private readonly telemetry: Telemetry) {}

  /** Prometheus text format */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): Promise<string> {
    return this.telemetry.metrics();
  }
}
