import { IsIn, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RUN_STATUSES, RunStatus } from '../run.types';

export class ListRunsQueryDto {
  @IsOptional()
  @IsIn(RUN_STATUSES)
  status?: RunStatus;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsMongoId()
  before?: string;
}
