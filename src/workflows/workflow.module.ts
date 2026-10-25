import { Module } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { TasksModule } from '../tasks/tasks.module';
import { TasksController } from './tasks.controller';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

@Module({
  imports: [OrchestratorModule, TasksModule],
  controllers: [WorkflowController, TasksController],
  providers: [WorkflowService],
})
export class WorkflowModule {}
