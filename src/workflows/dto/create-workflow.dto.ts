import { IsString, IsArray, IsOptional, ValidateNested, ArrayMinSize, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class WorkflowStepDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  task: string;

  @IsOptional()
  params?: Record<string, any>;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(0)
  dependsOn: string[];
}

export class CreateWorkflowDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  @ArrayMinSize(1)
  steps: WorkflowStepDto[];
}
  