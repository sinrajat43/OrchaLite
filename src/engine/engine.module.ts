import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { ENGINE_OPTIONS, engineOptionsFromEnv } from './engine-options';
import { EngineSignals } from './engine-signals';
import { EngineService } from './engine.service';

@Module({
  imports: [OrchestratorModule, ConnectionsModule],
  providers: [{ provide: ENGINE_OPTIONS, useFactory: () => engineOptionsFromEnv() }, EngineSignals, EngineService],
  exports: [EngineSignals, ENGINE_OPTIONS],
})
export class EngineModule {}
