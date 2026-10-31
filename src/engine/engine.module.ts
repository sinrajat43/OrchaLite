import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { ENGINE_OPTIONS, engineOptionsFromEnv } from './engine-options';
import { EngineSignals } from './engine-signals';
import { EngineService } from './engine.service';
import { LeaderState } from './leader-state';

@Module({
  imports: [OrchestratorModule, ConnectionsModule],
  providers: [{ provide: ENGINE_OPTIONS, useFactory: () => engineOptionsFromEnv() }, EngineSignals, LeaderState, EngineService],
  exports: [EngineSignals, LeaderState, ENGINE_OPTIONS],
})
export class EngineModule {}
