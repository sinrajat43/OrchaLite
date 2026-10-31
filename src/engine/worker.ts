import { Logger } from '@nestjs/common';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { resolveTemplate } from '../expressions/template';
import { formatSchemaErrors, validatorFor } from '../orchestrator/schema-validator';
import { TaskLookup } from '../orchestrator/task-registry.service';
import { RetryPolicy } from '../orchestrator/workflow-definition';
import { appendRunEvent } from '../runs/run-recorder';
import { RunStore } from '../runs/run-store';
import { RunSummary } from '../runs/run.types';
import { ConnectionLookup, SuspendTask, TaskLogger, TerminalTaskError } from '../tasks/task.interface';
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
  options: Pick<EngineOptions, 'leaseMs' | 'workerSlots' | 'workerPollMs' | 'defaultStepTimeoutMs' | 'maxLostDeliveries'>;
  /** Builds the logger handed to a step; defaults to a Nest Logger */
  createLogger?: (context: string) => TaskLogger;
}

/** Well under MongoDB's 16 MB document limit, so a large output fails the step and not the write */
export const MAX_ROW_OUTPUT_BYTES = 8 * 1024 * 1024;

const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * The wait before the next try: exponential, with half of it random ("equal
 * jitter"), so steps that failed together do not all come back together
 */
export function backoffMs(policy: RetryPolicy, failedAttempts: number, random: () => number = Math.random): number {
  const { backoffMs: base = DEFAULT_BACKOFF_MS, multiplier = DEFAULT_MULTIPLIER, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = policy;
  const ceiling = Math.min(maxBackoffMs, base * multiplier ** (failedAttempts - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Raised for a failure that belongs to the step, as opposed to the database or this process */
class StepFailure extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

/** This worker no longer holds the step, so whatever it was doing no longer counts */
class LeaseLost extends Error {}

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
    const { store, queue, signals, options } = this.deps;
    const row = await store.getStepRun(claim.job.id);

    // Already done or skipped: a redelivery after a commit, or a queued job of a failed run
    if (!row || isFinished(row)) return queue.ack(claim);

    // A worker died after asking to wait but before releasing the job
    if (row.notBefore && new Date(row.notBefore).getTime() > Date.now()) return queue.release(claim, new Date(row.notBefore));

    // Every take of a row is either a failure on record, a wake-up from a wait, or a worker that vanished
    const lost = row.fence - (row.failures?.length ?? 0) - (row.resumed ? 1 : 0);
    if (lost >= options.maxLostDeliveries) {
      const error = `Gave up after ${lost} deliveries in which the worker disappeared; the step may be crashing its worker`;
      const buried = await store.updateStepRun(row.id, { fence: row.fence }, { status: 'DEAD_LETTERED', error, endedAt: new Date() });
      if (buried) await queue.ack(claim);
      signals.runChanged(row.runId);
      return;
    }

    // Take the row: from here on, only this worker's fence can commit to it
    const taken = await store.updateStepRun(
      row.id,
      { fence: row.fence, status: ['PENDING', 'QUEUED', 'RUNNING', 'WAITING'] },
      { status: 'RUNNING', startedAt: row.startedAt ?? new Date() },
      { takeFence: true }
    );
    if (!taken) return;
    signals.runChanged(row.runId);

    // Aborts the task if the lease goes; a timeout aborts it the same way
    const abort = new AbortController();
    const stopHeartbeat = this.heartbeat(claim, abort);
    let changes: Partial<StepRun>;
    try {
      changes = await this.outcome(taken, abort);
    } catch (error) {
      if (error instanceof LeaseLost) {
        this.logger.warn(`Worker ${this.id}: stopped working on ${row.id}: lease lost`);
        return;
      }
      if (error instanceof SuspendTask) {
        const notBefore = new Date(Date.now() + error.ms);
        const waiting = await store.updateStepRun(row.id, { fence: taken.fence }, { status: 'WAITING', notBefore, resumed: true });
        if (waiting) await queue.release(claim, notBefore);
        signals.runChanged(row.runId);
        return;
      }
      if (!(error instanceof StepFailure)) throw error;
      changes = await this.afterFailure(taken, claim, error);
      if (!changes) return;
    } finally {
      stopHeartbeat();
    }

    const committed = await store.updateStepRun(row.id, { fence: taken.fence }, { ...changes, endedAt: new Date() });
    if (!committed) {
      this.logger.warn(`Worker ${this.id}: lost ${row.id} to a newer delivery; dropping this result`);
      return;
    }
    await queue.ack(claim);
    signals.runChanged(row.runId);
  }

  /**
   * Schedules another try if the failure allows one
   * @returns how to end the step, or null if it will be tried again
   */
  private async afterFailure(row: StepRun, claim: Claim, failure: StepFailure): Promise<Partial<StepRun> | null> {
    const { store, queue, signals } = this.deps;
    const run = await store.getRun(row.runId);
    const policy = this.compiled.steps(run).get(row.stepId)?.step.retry;
    const maxAttempts = policy?.maxAttempts ?? 1;
    const attempt = (row.failures?.length ?? 0) + 1;

    if (!failure.retryable) return { status: 'FAILED', error: failure.message };
    if (attempt >= maxAttempts) {
      // Only a step that was meant to be retried ran out of tries; otherwise it simply failed
      return maxAttempts > 1
        ? { status: 'DEAD_LETTERED', error: `Gave up after ${attempt} attempts: ${failure.message}` }
        : { status: 'FAILED', error: failure.message };
    }

    const notBefore = new Date(Date.now() + backoffMs(policy, attempt));
    const failures = [...(row.failures ?? []), { attempt, error: failure.message, at: new Date() }];
    const waiting = await store.updateStepRun(row.id, { fence: row.fence }, { status: 'WAITING', notBefore, failures, resumed: false });
    if (!waiting) return null;
    await queue.release(claim, notBefore);
    signals.runChanged(row.runId);
    // Only informs; the row already holds the truth, so losing this event loses nothing
    await appendRunEvent(store, row.runId, 'StepRetryScheduled', { stepId: row.stepId, index: row.index, attempt, error: failure.message, retryAt: notBefore }).catch(error =>
      this.logger.warn(`Worker ${this.id}: could not record a retry of ${row.id}: ${error.message}`)
    );
    return null;
  }

  /** Renews the lease while the task runs, and aborts the task if it is lost */
  private heartbeat(claim: Claim, abort: AbortController): () => void {
    const { queue, options } = this.deps;
    const timer = setInterval(() => {
      queue.extend(claim, options.leaseMs).then(
        held => {
          if (!held) abort.abort(new LeaseLost());
        },
        // Maybe a blip; if it lasts, the lease runs out and the fence still protects the row
        error => this.logger.warn(`Worker ${this.id}: could not renew ${claim.job.id}: ${error.message}`)
      );
    }, Math.max(1, Math.floor(options.leaseMs / 3)));
    return () => clearInterval(timer);
  }

  /**
   * Resolves the row's params and runs its task
   * @throws StepFailure if the step failed
   * @throws LeaseLost if this worker no longer holds the step
   * @throws SuspendTask if the task asked to wait
   */
  private async outcome(row: StepRun, abort: AbortController): Promise<Partial<StepRun>> {
    const { store, tasks, connections, options } = this.deps;
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
    const timeoutMs = compiled.step.timeoutMs ?? options.defaultStepTimeoutMs;
    const timedOut = new Error(`Timed out after ${timeoutMs} ms`);
    const timer = setTimeout(() => abort.abort(timedOut), timeoutMs);
    // A task that ignores its signal must still give up its slot, so the abort ends the wait for it
    const aborted = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(abort.signal.reason);
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
    });

    let output: unknown;
    try {
      const running = task.execute({
        params,
        signal: abort.signal,
        attempt: (row.failures?.length ?? 0) + 1,
        idempotencyKey: row.id,
        logger: createLogger(`${row.task} run=${row.runId} step=${row.stepId}${label}`),
        connections,
        resumed: row.resumed === true,
      });
      output = await Promise.race([running, aborted]);
    } catch (error) {
      if (error instanceof SuspendTask || error instanceof LeaseLost) throw error;
      // The abort reason wins over whatever the aborted task threw, usually "canceled"
      if (abort.signal.reason instanceof LeaseLost) throw abort.signal.reason;
      const message = `Task execution failed${label}: ${(error as Error)?.message ?? error}`;
      throw new StepFailure(message, !(error instanceof TerminalTaskError));
    } finally {
      clearTimeout(timer);
    }

    if (Buffer.byteLength(JSON.stringify(output) ?? '') > MAX_ROW_OUTPUT_BYTES) {
      throw new StepFailure(`Task execution failed${label}: its output is over the ${MAX_ROW_OUTPUT_BYTES} byte limit`);
    }
    return { status: 'SUCCEEDED', output };
  }
}
