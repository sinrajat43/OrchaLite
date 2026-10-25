import { IsString, IsArray, IsOptional, ValidateNested, ArrayMinSize, IsNotEmpty, IsObject, IsDefined } from 'class-validator';
import { Type } from 'class-transformer';

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
}

export class WorkflowDefinitionDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, any>;

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
