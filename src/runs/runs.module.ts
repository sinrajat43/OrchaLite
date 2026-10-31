import { DynamicModule, Module } from '@nestjs/common';
import { InMemoryStepQueue } from '../engine/in-memory-step-queue';
import { InMemoryLeaderLock, LEADER_LOCK, LeaderLock, MongoLeaderLock } from '../engine/leader-lock';
import { InMemoryRateLimiter, MongoRateLimiter, RATE_LIMITER, RateLimiter } from '../engine/rate-limiter';
import { STEP_QUEUE, StepQueue } from '../engine/step-queue';
import { stepQueueFromEnv } from '../engine/step-queue-factory';
import { MongoRunStore } from './mongo-run-store';
import { RUN_STORE, RunStore } from './run-store';
import { DeadLettersController, RunsController } from './runs.controller';

@Module({})
export class RunsModule {
  /**
   * Run history API and the stores behind runs, global so other modules can
   * inject them. MongoDB by default; tests pass in-memory ones.
   */
  static forRoot(store: RunStore = new MongoRunStore(), queue?: StepQueue, limiter: RateLimiter = new MongoRateLimiter(), lock: LeaderLock = new MongoLeaderLock()): DynamicModule {
    return {
      module: RunsModule,
      global: true,
      controllers: [RunsController, DeadLettersController],
      providers: [
        { provide: RUN_STORE, useValue: store },
        // Chosen as the app starts: this module is declared at import time, before .env is loaded
        { provide: STEP_QUEUE, useFactory: () => queue ?? stepQueueFromEnv() },
        { provide: RATE_LIMITER, useValue: limiter },
        { provide: LEADER_LOCK, useValue: lock },
      ],
      exports: [RUN_STORE, STEP_QUEUE, RATE_LIMITER, LEADER_LOCK],
    };
  }

  /** Everything in process memory */
  static inMemory(store: RunStore, queue: StepQueue = new InMemoryStepQueue()): DynamicModule {
    return RunsModule.forRoot(store, queue, new InMemoryRateLimiter(), new InMemoryLeaderLock());
  }
}
