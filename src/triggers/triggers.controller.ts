import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, Post, Put, RawBodyRequest, Req } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Min, MinLength } from 'class-validator';
import { Request } from 'express';
import { AcceptedRun } from '../workflows/workflow.service';
import { TriggersService, TriggerView } from './triggers.service';

const TRIGGER_NAME = /^[A-Za-z0-9_.-]+$/;

export class PutTriggerDto {
  @IsIn(['cron', 'webhook'])
  type: 'cron' | 'webhook';

  @IsString()
  workflow: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  cron?: string;

  /** Generated, and shown once, if not given */
  @IsOptional()
  @IsString()
  @MinLength(16)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@Controller()
export class TriggersController {
  constructor(private readonly triggers: TriggersService) {}

  @Get('triggers')
  list(): Promise<TriggerView[]> {
    return this.triggers.list();
  }

  @Put('triggers/:name')
  put(@Param('name') name: string, @Body() dto: PutTriggerDto): Promise<TriggerView & { secret?: string }> {
    if (!TRIGGER_NAME.test(name)) throw new BadRequestException('Trigger names may only contain letters, digits, _, . and -');
    return this.triggers.put(name, dto);
  }

  @Delete('triggers/:name')
  @HttpCode(204)
  async delete(@Param('name') name: string): Promise<void> {
    if (!(await this.triggers.delete(name))) throw new NotFoundException(`Unknown trigger "${name}"`);
  }

  /** Where a sender delivers a signed event */
  @Post('hooks/:name')
  @HttpCode(202)
  deliver(
    @Param('name') name: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>
  ): Promise<AcceptedRun> {
    return this.triggers.deliver(name, request.rawBody ?? Buffer.from(''), headers);
  }
}
