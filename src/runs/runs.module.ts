import { DynamicModule, Module } from '@nestjs/common';
import { MongoRunStore } from './mongo-run-store';
import { RunRecorder } from './run-recorder';
import { RUN_STORE, RunStore } from './run-store';
import { RunsController } from './runs.controller';

@Module({})
export class RunsModule {
  /**
   * Run history API and recorder, global so other modules can inject them.
   * Defaults to MongoDB; tests pass an InMemoryRunStore.
   */
  static forRoot(store: RunStore = new MongoRunStore()): DynamicModule {
    return {
      module: RunsModule,
      global: true,
      controllers: [RunsController],
      providers: [{ provide: RUN_STORE, useValue: store }, RunRecorder],
      exports: [RUN_STORE, RunRecorder],
    };
  }
}
