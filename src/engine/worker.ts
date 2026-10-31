import { Logger } from '@nestjs/common';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { resolveTemplate } from '../expressions/template';
import { formatSchemaErrors, validatorFor } from '../orchestrator/schema-validator';
import { TaskLookup } from '../orchestrator/task-registry.service';
import { RunStore } from '../runs/run-store';
import { RunSummary } from '../runs/run.types';
import { ConnectionLookup, SuspendTask, TaskLogger } from '../tasks/task.interface';
import { CompiledRuns } from './compiled-runs';
import { EngineOptions } from './engine-options';
import { EngineSignals } from './engine-signals';
import { Claim, StepQueue } from './step-queue';
import { isFinished, StepRun } from './step-run';

export interface WorkerDeps {
  store: RunStore;
  queue: StepQueue;
  tasks: TaskLookup;
  connections: ConnectionLookup;
  signals: EngineSignals;
  options: Pick<EngineOptions, 'leaseMs' | 'workerSlots' | 'workerPollMs'>;
  /** Builds the logger handed to a step; defaults to a Nest Logger */
  createLogger?: (context: string) => TaskLogger;
}

/** Raised for a failure that belongs to the step, as opposed to the database or this process */
class StepFailure extends Error {}

/**
 * Takes jobs off the queue and runs them. A worker holds a job under a lease it
 * keeps renewing while the task runs; if the process dies the renewals stop, the
 * lease runs out and another worker gets the job. So a task can start twice, and
 * every commit is fenced so only the latest holder's result counts.
 *
 * Workers only write step rows. The scheduler reads them and does the rest.
 */
export class Worker {
  readonly id = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private readonly logger = new Logger(Worker.name);
  private readonly compiled: CompiledRuns;
  private stopping = false;
  private loops: Promise<void>[] = [];
  private wakeSleepers: (() => void)[] = [];
  private unsubscribe?: () => void;

  constructor(private readonly deps: WorkerDeps) {
    this.compiled = new CompiledRuns(deps.tasks);
  }

  start(): void {
    this.unsubscribe = this.deps.signals.onJobsAvailable(() => this.wake());
    this.loops = Array.from({ length: this.deps.options.workerSlots }, () => this.loop());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.wake();
    await Promise.all(this.loops);
  }

  private wake(): void {
    this.wakeSleepers.splice(0).forEach(wake => wake());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeSleepers.push(done);
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const claim = await this.deps.queue.claim(this.id, this.deps.options.leaseMs);
        if (claim) await this.work(claim);
        else await this.sleep(this.deps.options.workerPollMs);
      } catch (error) {
        // Most likely the database. The job's lease will run out, so nothing is lost
        this.logger.error(`Worker ${this.id}: ${(error as Error).message}`);
        await this.sleep(this.deps.options.workerPollMs);
      }
    }
  }

  private async work(claim: Claim): Promise<void> {
    const { store, queue, signals } = this.deps;
    const row = await store.getStepRun(claim.job.id);

    // Already done or skipped: a redelivery after a commit, or a queued job of a failed run
    if (!row || isFinished(row)) return queue.ack(claim);

    // A worker died after asking to wait but before releasing the job
    if (row.resumeAt && row.resumeAt.getTime() > Date.now()) return queue.release(claim, row.resumeAt);

    // Take the row: from here on, only this worker's fence can commit to it
    const taken = await store.updateStepRun(
      row.id,
      { fence: row.fence, status: ['PENDING', 'QUEUED', 'RUNNING', 'WAITING'] },
      { status: 'RUNNING', startedAt: row.startedAt ?? new Date() },
      { takeFence: true }
    );
    if (!taken) return;
    signals.runChanged(row.runId);

    const stopHeartbeat = this.heartbeat(claim);
    let changes: Partial<StepRun> | null;
    try {
      changes = await this.outcome(taken);
    } catch (error) {
      if (error instanceof SuspendTask) {
        changes = null;
        const resumeAt = new Date(Date.now() + error.ms);
        const waiting = await store.updateStepRun(row.id, { fence: taken.fence }, { status: 'WAITING', resumeAt });
        stopHeartbeat();
        if (waiting) await queue.release(claim, resumeAt);
        signals.runChanged(row.runId);
        return;
      }
      if (!(error instanceof StepFailure)) {
        stopHeartbeat();
        throw error;
      }
      changes = { status: 'FAILED', error: error.message };
    }
    stopHeartbeat();

    const committed = await store.updateStepRun(row.id, { fence: taken.fence }, { ...changes, endedAt: new Date() });
    if (!committed) {
      this.logger.warn(`Worker ${this.id}: lost ${row.id} to a newer delivery; dropping this result`);
      return;
    }
    await queue.ack(claim);
    signals.runChanged(row.runId);
  }

  /** Renews the lease while the task runs */
  private heartbeat(claim: Claim): () => void {
    const { queue, options } = this.deps;
    const timer = setInterval(() => {
      queue.extend(claim, options.leaseMs).then(
        held => {
          if (!held) this.logger.warn(`Worker ${this.id}: lease on ${claim.job.id} was lost`);
        },
        error => this.logger.warn(`Worker ${this.id}: could not renew ${claim.job.id}: ${error.message}`)
      );
    }, Math.max(1, Math.floor(options.leaseMs / 3)));
    return () => clearInterval(timer);
  }

  /**
   * Resolves the row's params and runs its task
   * @throws StepFailure if the step failed
   */
  private async outcome(row: StepRun): Promise<Partial<StepRun>> {
    const { store, tasks, connections } = this.deps;
    const label = row.index === undefined ? '' : ` [item ${row.index}]`;

    const run: RunSummary | null = await store.getRun(row.runId);
    if (!run) throw new StepFailure(`Run ${row.runId} no longer exists`);

    let compiled;
    try {
      compiled = this.compiled.steps(run).get(row.stepId);
    } catch (error) {
      throw new StepFailure((error as Error).message);
    }
    const task = tasks.get(row.task);
    if (!compiled || !task) throw new StepFailure(`This worker has no task "${row.task}"`);

    const outputs = await store.getStepOutputs(row.runId, [...compiled.upstream]);
    const scope = {
      input: run.input ?? {},
      steps: Object.fromEntries([...compiled.upstream].map(id => [id, { output: outputs[id] }])),
      ...(row.index === undefined ? {} : { item: row.item, index: row.index }),
    };

    let params: Record<string, unknown>;
    try {
      params = (await resolveTemplate(compiled.params, scope, 'params')) as Record<string, unknown>;
    } catch (error) {
      throw new StepFailure(`Could not resolve params: ${(error as Error).message}`);
    }

    // Expressions can produce anything, so check the resolved params; this also fills in defaults
    const validateParams = validatorFor(task.paramsSchema);
    if (!validateParams(params)) {
      throw new StepFailure(`Invalid params${label}: ${formatSchemaErrors(validateParams.errors, 'params').join('; ')}`);
    }

    const createLogger = this.deps.createLogger ?? ((context: string) => new Logger(context));
    let output: unknown;
    try {
      output = await task.execute({
        params,
        // Nothing aborts the signal yet; timeouts and cancellation arrive in B3
        signal: new AbortController().signal,
        attempt: 1,
        idempotencyKey: row.id,
        logger: createLogger(`${row.task} run=${row.runId} step=${row.stepId}${label}`),
        connections,
        resumed: row.resumeAt !== undefined,
      });
    } catch (error) {
      if (error instanceof SuspendTask) throw error;
      throw new StepFailure(`Task execution failed${label}: ${(error as Error)?.message ?? error}`);
    }
    return { status: 'SUCCEEDED', output };
  }
}
