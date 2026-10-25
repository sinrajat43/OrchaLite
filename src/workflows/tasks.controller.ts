import { Controller, Get } from '@nestjs/common';
import { TaskRegistry } from '../orchestrator/task-registry.service';

export interface TaskDescription {
  name: string;
  version: number;
  description?: string;
  paramsSchema: object;
  outputSchema: object;
}

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TaskRegistry) {}

  /**
   * The task catalogue, with JSON Schemas for each task's params and output
   */
  @Get()
  list(): TaskDescription[] {
    return this.tasks.list().map(({ name, version, description, task }) => ({
      name,
      version,
      description,
      paramsSchema: task.paramsSchema,
      outputSchema: task.outputSchema,
    }));
  }
}
