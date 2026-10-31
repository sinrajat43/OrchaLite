import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflows/workflow.module';
import { DefinitionsController } from './definitions.controller';
import { DefinitionStore } from './definition-store.service';

@Module({
  imports: [WorkflowModule],
  controllers: [DefinitionsController],
  providers: [DefinitionStore],
  exports: [DefinitionStore],
})
export class DefinitionsModule {}
