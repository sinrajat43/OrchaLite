import { IsString, IsArray, IsOptional, ValidateNested, ArrayMinSize, IsNotEmpty, IsObject, IsDefined, Matches, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RetryPolicy } from '../../orchestrator/workflow-definition';

export class WorkflowStepDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  task: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, any>;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(0)
  dependsOn: string[];

  @IsOptional()
  @IsString()
  when?: string;

  @IsOptional()
  @IsString()
  forEach?: string;

  /** Checked in full with the rest of the definition */
  @IsOptional()
  @IsObject()
  retry?: RetryPolicy;

  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  concurrency?: number;
}

export const WORKFLOW_NAME = /^[A-Za-z0-9_.-]+$/;

export class WorkflowDefinitionDto {
  @IsString()
  @Matches(WORKFLOW_NAME, { message: 'name may only contain letters, digits, _, . and -' })
  name: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, any>;

  @IsOptional()
  @IsInt()
  @Min(1)
  concurrency?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  @ArrayMinSize(1)
  steps: WorkflowStepDto[];
}

export class RunWorkflowDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => WorkflowDefinitionDto)
  definition: WorkflowDefinitionDto;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}

export class RunStoredWorkflowDto {
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  /** Defaults to the latest version */
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
