import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { ConnectionsService } from '../connections/connections.service';
import { TaskRegistry } from '../orchestrator/task-registry.service';
import { RUN_STORE, RunStore } from '../runs/run-store';
import { TELEMETRY, Telemetry } from '../telemetry/telemetry';
import { appendRunEvent } from '../runs/run-recorder';
import { ENGINE_OPTIONS, EngineOptions } from './engine-options';
import { EngineSignals } from './engine-signals';
import { RATE_LIMITER, RateLimiter } from './rate-limiter';
import { Scheduler } from './scheduler';
import { LeaderElection } from './leader-election';
import { LEADER_LOCK, LeaderLock } from './leader-lock';
import { LeaderState } from './leader-state';
import { OutboxRelay, WebhookEventPublisher } from './outbox';
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
  private election?: LeaderElection;
  private outbox?: OutboxRelay;

  constructor(
    @Inject(RUN_STORE) private readonly store: RunStore,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(LEADER_LOCK) private readonly lock: LeaderLock,
    @Inject(ENGINE_OPTIONS) private readonly options: EngineOptions,
    private readonly leader: LeaderState,
    @Inject(TELEMETRY) private readonly telemetry: Telemetry,
    private readonly tasks: TaskRegistry,
    private readonly connections: ConnectionsService,
    private readonly signals: EngineSignals
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { store, queue, limiter, tasks, connections, signals, options, telemetry } = this;
    telemetry.onCollect(async () => ({ queue: await queue.depth(), activeRuns: await store.countActiveRuns() }));
    if (options.roles.includes('scheduler')) {
      await this.abandonLegacyRuns();
      // Several schedulers can run for failover; the one holding the lock does the work
      this.election = new LeaderElection(this.lock, `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`, options.leaderTtlMs);
      this.leader.source = this.election;
      await this.election.start();
      const isLeader = () => this.election.isLeader;
      this.scheduler = new Scheduler({ store, queue, tasks, signals, options, isLeader, telemetry });
      this.scheduler.start();
      if (options.eventsWebhookUrl) {
        this.outbox = new OutboxRelay(store, new WebhookEventPublisher(options.eventsWebhookUrl), options.schedulerIntervalMs, isLeader);
        this.outbox.start();
      }
    }
    if (options.roles.includes('worker')) {
      this.worker = new Worker({ store, queue, tasks, connections, limiter, signals, options, telemetry });
      this.worker.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker?.stop();
    await this.scheduler?.stop();
    await this.outbox?.stop();
    await this.election?.stop();
    await this.telemetry.shutdown();
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
