import { Module } from '@nestjs/common';
import { DefinitionsModule } from '../definitions/definitions.module';
import { EngineModule } from '../engine/engine.module';
import { WorkflowModule } from '../workflows/workflow.module';
import { TriggerStore } from './trigger-store.service';
import { TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';

@Module({
  imports: [DefinitionsModule, WorkflowModule, EngineModule],
  controllers: [TriggersController],
  providers: [TriggerStore, TriggersService],
})
export class TriggersModule {}
