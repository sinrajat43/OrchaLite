import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { TasksModule } from '../tasks/tasks.module';
import { TasksController } from './tasks.controller';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

@Module({
  imports: [OrchestratorModule, TasksModule, ConnectionsModule],
  controllers: [WorkflowController, TasksController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
