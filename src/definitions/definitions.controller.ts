import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { RunResult } from '../runs/run-result';
import { RunStoredWorkflowDto, WorkflowDefinitionDto } from '../workflows/dto/workflow.dto';
import { AcceptedRun, WorkflowService } from '../workflows/workflow.service';
import { DefinitionStore, DefinitionSummary, StoredDefinition } from './definition-store.service';

@Controller('workflows')
export class DefinitionsController {
  constructor(
    private readonly store: DefinitionStore,
    private readonly workflows: WorkflowService
  ) {}

  /**
   * Validates a definition and stores it as the next version of its name
   */
  @Post()
  save(@Body() definition: WorkflowDefinitionDto): Promise<{ name: string; version: number; created: boolean }> {
    this.workflows.validate(definition);
    return this.store.save(definition);
  }

  @Get()
  list(): Promise<DefinitionSummary[]> {
    return this.store.list();
  }

  @Get(':name')
  latest(@Param('name') name: string): Promise<StoredDefinition> {
    return this.find(name);
  }

  @Get(':name/versions')
  async versions(@Param('name') name: string): Promise<{ version: number; createdAt: Date }[]> {
    const versions = await this.store.versions(name);
    if (!versions.length) throw new NotFoundException(`Unknown workflow "${name}"`);
    return versions;
  }

  @Get(':name/versions/:version')
  version(@Param('name') name: string, @Param('version', ParseIntPipe) version: number): Promise<StoredDefinition> {
    return this.find(name, version);
  }

  /**
   * Starts a run of a stored version, the latest by default
   */
  @Post(':name/runs')
  @HttpCode(202)
  async run(
    @Param('name') name: string,
    @Body() { input, version }: RunStoredWorkflowDto,
    @Query('wait') wait: string | undefined,
    @Res({ passthrough: true }) response: Response
  ): Promise<AcceptedRun | RunResult> {
    const stored = await this.find(name, version);
    const accepted = await this.workflows.start(stored.definition, input, { name, version: stored.version });
    return this.workflows.respond(accepted, wait, response);
  }

  private async find(name: string, version?: number): Promise<StoredDefinition> {
    const stored = await this.store.get(name, version);
    if (!stored) {
      throw new NotFoundException(version ? `Workflow "${name}" has no version ${version}` : `Unknown workflow "${name}"`);
    }
    return stored;
  }
}
