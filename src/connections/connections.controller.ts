import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Put, ServiceUnavailableException,
} from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsUrl, Matches } from 'class-validator';
import { ConnectionsDisabledError, ConnectionsService, ConnectionSummary } from './connections.service';

export const CONNECTION_NAME = /^[A-Za-z0-9_.-]+$/;

export class PutConnectionDto {
  @IsIn(['http'])
  type: 'http';

  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  baseUrl: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsObject()
  query?: Record<string, string>;
}

const disabledToHttp = (error: unknown) => {
  if (error instanceof ConnectionsDisabledError) throw new ServiceUnavailableException(error.message);
  throw error;
};

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  list(): Promise<ConnectionSummary[]> {
    return this.connections.list();
  }

  /** Creates or replaces a connection; the response never includes secret values */
  @Put(':name')
  put(@Param('name') name: string, @Body() dto: PutConnectionDto): Promise<ConnectionSummary> {
    if (!CONNECTION_NAME.test(name)) {
      throw new BadRequestException('Connection names may only contain letters, digits, _, . and -');
    }
    for (const field of ['headers', 'query'] as const) {
      if (Object.values(dto[field] ?? {}).some(value => typeof value !== 'string')) {
        throw new BadRequestException(`${field} values must be strings`);
      }
    }
    return this.connections.put(name, dto).catch(disabledToHttp);
  }

  @Delete(':name')
  @HttpCode(204)
  async delete(@Param('name') name: string): Promise<void> {
    if (!(await this.connections.delete(name))) throw new NotFoundException(`Unknown connection "${name}"`);
  }
}
