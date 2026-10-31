import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { ENGINE_OPTIONS, engineOptionsFromEnv } from './engine-options';
import { EngineSignals } from './engine-signals';
import { EngineService } from './engine.service';
import { LeaderState } from './leader-state';
import { EngineTelemetry, TELEMETRY } from '../telemetry/telemetry';

@Module({
  imports: [OrchestratorModule, ConnectionsModule],
  providers: [{ provide: ENGINE_OPTIONS, useFactory: () => engineOptionsFromEnv() }, EngineSignals, LeaderState, { provide: TELEMETRY, useFactory: () => new EngineTelemetry() }, EngineService],
  exports: [EngineSignals, LeaderState, ENGINE_OPTIONS, TELEMETRY],
})
export class EngineModule {}
