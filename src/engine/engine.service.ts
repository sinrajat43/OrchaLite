import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConnectionsService } from '../connections/connections.service';
import { TaskRegistry } from '../orchestrator/task-registry.service';
import { RUN_STORE, RunStore } from '../runs/run-store';
import { appendRunEvent } from '../runs/run-recorder';
import { ENGINE_OPTIONS, EngineOptions } from './engine-options';
import { EngineSignals } from './engine-signals';
import { Scheduler } from './scheduler';
import { STEP_QUEUE, StepQueue } from './step-queue';
import { Worker } from './worker';

/**
 * Starts this process's part of the engine, by its roles, once the app is up,
 * and stops it before the database closes
 */
@Injectable()
export class EngineService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private scheduler?: Scheduler;
  private worker?: Worker;

  constructor(
    @Inject(RUN_STORE) private readonly store: RunStore,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(ENGINE_OPTIONS) private readonly options: EngineOptions,
    private readonly tasks: TaskRegistry,
    private readonly connections: ConnectionsService,
    private readonly signals: EngineSignals
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { store, queue, tasks, connections, signals, options } = this;
    if (options.roles.includes('scheduler')) {
      await this.abandonLegacyRuns();
      this.scheduler = new Scheduler({ store, queue, tasks, signals, options });
      this.scheduler.start();
    }
    if (options.roles.includes('worker')) {
      this.worker = new Worker({ store, queue, tasks, connections, signals, options });
      this.worker.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker?.stop();
    await this.scheduler?.stop();
  }

  /**
   * Runs from before the queue have no step rows to resume from, so they
   * cannot be recovered: close them, keeping the history they have
   */
  private async abandonLegacyRuns(): Promise<void> {
    try {
      for (const run of await this.store.findRunning()) {
        if (!run.execution) {
          await appendRunEvent(this.store, run.id, 'RunAbandoned', { error: 'The server stopped while this run was in progress' });
        }
      }
    } catch (error) {
      console.error('Engine: startup check for old runs failed:', error);
    }
  }
}
