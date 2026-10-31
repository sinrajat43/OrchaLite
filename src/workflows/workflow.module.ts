import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { TasksModule } from '../tasks/tasks.module';
import { TasksController } from './tasks.controller';
import { MetricsController, RunActionsController, WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

@Module({
  imports: [OrchestratorModule, TasksModule, EngineModule],
  controllers: [WorkflowController, RunActionsController, MetricsController, TasksController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
