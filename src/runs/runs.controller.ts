import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';
import { RunResult, toRunResult } from './run-result';
import { RUN_STORE, RunStore } from './run-store';
import { RunEvent, RunSummary } from './run.types';

@Controller('runs')
export class RunsController {
  constructor(@Inject(RUN_STORE) private readonly store: RunStore) {}

  @Get()
  listRuns(@Query() query: ListRunsQueryDto): Promise<RunSummary[]> {
    return this.store.listRuns({ ...query, limit: query.limit ?? 20 });
  }

  @Get(':id')
  async getRun(@Param('id') id: string): Promise<RunSummary> {
    const run = await this.store.getRun(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return run;
  }

  /**
   * The run's status with each step's output
   */
  @Get(':id/result')
  async getResult(@Param('id') id: string): Promise<RunResult> {
    return toRunResult(await this.getRun(id), await this.store.getEvents(id));
  }

  @Get(':id/events')
  async getEvents(@Param('id') id: string): Promise<RunEvent[]> {
    const events = await this.store.getEvents(id);
    if (!events.length && !(await this.store.getRun(id))) {
      throw new NotFoundException(`Run ${id} not found`);
    }
    return events;
  }
}
