import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TaskRegistry } from './task-registry.service';

@Module({
  imports: [DiscoveryModule],
  providers: [TaskRegistry],
  exports: [TaskRegistry],
})
export class OrchestratorModule {}
