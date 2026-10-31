import { Logger } from '@nestjs/common';
import { isTruthy, resolveTemplate, Template } from '../expressions/template';
import { TaskLookup } from '../orchestrator/task-registry.service';
import { CompiledStep } from '../orchestrator/workflow-definition';
import { capOutput, appendRunEvent } from '../runs/run-recorder';
import { DuplicateEventError, RunStore } from '../runs/run-store';
import { IllegalTransitionError } from '../runs/run-projection';
import { RunSummary } from '../runs/run.types';
import { CompiledRuns } from './compiled-runs';
import { EngineOptions } from './engine-options';
import { EngineSignals } from './engine-signals';
import { StepQueue } from './step-queue';
import { isFailure, isFinished, newStepRun, StepRun } from './step-run';
import { MAX_ROW_OUTPUT_BYTES } from './worker';

/** forEach items are stored one row each, so keep fan-out bounded */
export const MAX_FOR_EACH_ITEMS = 1000;

export interface SchedulerDeps {
  store: RunStore;
  queue: StepQueue;
  tasks: TaskLookup;
  signals: EngineSignals;
  options: Pick<EngineOptions, 'schedulerIntervalMs'>;
}

const SKIP_AFTER_FAILURE = 'an earlier step failed';

/**
 * Decides what happens next in each active run. It works level-triggered: every
 * pass compares what the step rows say with what the run's timeline says and
 * closes the gap, so it does not matter how many passes a crash or a missed
 * nudge costs, or how many schedulers are running. Every write it makes is
 * idempotent or conditional, and the next pass finishes whatever a crash left.
 *
 * It is also the one author of a run's lifecycle events, which it derives from
 * the rows the workers write.
 */
export class Scheduler {
  private readonly logger = new Logger(Scheduler.name);
  private readonly compiled: CompiledRuns;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  /** Runs being advanced in this process; a nudge during a pass asks for another pass */
  private readonly advancing = new Map<string, { promise: Promise<void>; again: boolean }>();
  private unsubscribe?: () => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.compiled = new CompiledRuns(deps.tasks);
  }

  start(): void {
    this.unsubscribe = this.deps.signals.onRunChanged(runId => void this.advance(runId));
    this.timer = setInterval(() => this.tick(), this.deps.options.schedulerIntervalMs);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    clearInterval(this.timer);
    await this.ticking;
    await Promise.all([...this.advancing.values()].map(entry => entry.promise));
  }

  private tick(): void {
    if (this.ticking) return;
    this.ticking = this.visitActiveRuns().finally(() => (this.ticking = undefined));
  }

  private async visitActiveRuns(): Promise<void> {
    try {
      for (const run of await this.deps.store.findRunning()) {
        await this.advance(run.id);
      }
    } catch (error) {
      this.logger.error(`Scheduler: ${(error as Error).message}`);
    }
  }

  /** Brings one run up to date; never throws. Concurrent calls collapse into one more pass. */
  advance(runId: string): Promise<void> {
    const current = this.advancing.get(runId);
    if (current) {
      current.again = true;
      return current.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          // Each pass may unblock more steps, such as a chain of skips
          while (await this.pass(runId));
        } while (entry.again);
      } catch (error) {
        // Lost a race with another writer, or a database error: the next tick tries again
        if (!(error instanceof DuplicateEventError) && !(error instanceof IllegalTransitionError)) {
          this.logger.error(`Scheduler: run ${runId}: ${(error as Error).message}`);
        }
      } finally {
        this.advancing.delete(runId);
      }
    })();
    this.advancing.set(runId, entry);
    return entry.promise;
  }

  /** @returns true if it changed something that may allow more progress */
  private async pass(runId: string): Promise<boolean> {
    const { store } = this.deps;
    const run = await store.getRun(runId);
    if (!run || run.status !== 'RUNNING' || !run.execution) return false;

    let steps: Map<string, CompiledStep>;
    try {
      steps = this.compiled.steps(run);
    } catch (error) {
      await appendRunEvent(store, runId, 'RunFailed', { error: (error as Error).message });
      return false;
    }

    const rows = await store.listStepRuns(runId);
    const mine = new Map(rows.filter(row => row.index === undefined).map(row => [row.stepId, row]));
    const items = rows.filter(row => row.index !== undefined);

    const changed =
      (await this.finishFanOuts(mine, items)) ||
      (await this.planSteps(run, steps, mine)) ||
      (await this.skipAfterFailure(rows));
    if (changed) return true;

    const reported = await this.report(run, steps, mine);
    if (reported) return true;

    await this.admit(rows);
    return this.finish(run, steps, rows, mine);
  }

  /** A forEach step ends when its items have: with their outputs in order, or with the first failure */
  private async finishFanOuts(mine: Map<string, StepRun>, items: StepRun[]): Promise<boolean> {
    const { store } = this.deps;
    let changed = false;
    for (const row of mine.values()) {
      if (!row.fanOut || isFinished(row)) continue;
      const own = items.filter(item => item.stepId === row.stepId).sort((a, b) => a.index - b.index);
      if (!own.every(isFinished)) continue;
      const failed = own.find(isFailure);
      const output = failed ? undefined : await store.getItemOutputs(row.runId, row.stepId);
      let update: Partial<StepRun> = failed
        ? { status: failed.status, error: failed.error }
        : { status: 'SUCCEEDED', output, iterations: own.length };
      if (!failed && Buffer.byteLength(JSON.stringify(output) ?? '') > MAX_ROW_OUTPUT_BYTES) {
        update = { status: 'FAILED', error: `The outputs of the ${own.length} items are too large to store together` };
      }
      if (await store.updateStepRun(row.id, { status: ['RUNNING'] }, { ...update, endedAt: new Date() })) changed = true;
    }
    return changed;
  }

  /** Creates the row of every step whose dependencies have all finished */
  private async planSteps(run: RunSummary, steps: Map<string, CompiledStep>, mine: Map<string, StepRun>): Promise<boolean> {
    const { store } = this.deps;
    const failed = [...mine.values()].some(isFailure);
    const created: StepRun[] = [];

    for (const compiled of steps.values()) {
      const { step } = compiled;
      if (mine.has(step.id)) continue;
      const base = { runId: run.id, stepId: step.id, task: step.task };

      if (failed) {
        created.push(newStepRun({ ...base, status: 'SKIPPED', reason: SKIP_AFTER_FAILURE }));
        continue;
      }
      const dependencies = step.dependsOn.map(dep => mine.get(dep));
      if (!dependencies.every(dep => dep && isFinished(dep))) continue;
      created.push(...(await this.planStep(run, compiled, dependencies, base)));
    }

    if (!created.length) return false;
    await store.insertStepRuns(created);
    return true;
  }

  /** What one ready step becomes: skipped, a job, or a fan-out over its items */
  private async planStep(
    run: RunSummary,
    { step, when, forEach, upstream }: CompiledStep,
    dependencies: StepRun[],
    base: Pick<StepRun, 'runId' | 'stepId' | 'task'>
  ): Promise<StepRun[]> {
    const now = new Date();
    const skip = (reason: string) => [newStepRun({ ...base, status: 'SKIPPED', reason, startedAt: now, endedAt: now })];
    const fail = (error: string) => [newStepRun({ ...base, status: 'FAILED', error, startedAt: now, endedAt: now })];

    // A skipped dependency produced nothing to work on, so skipping travels downstream
    const skipped = dependencies.find(dep => dep.status === 'SKIPPED');
    if (skipped) return skip(`dependency "${skipped.stepId}" was skipped`);

    const outputs = when || forEach ? await this.deps.store.getStepOutputs(run.id, [...upstream]) : {};
    const scope = {
      input: run.input ?? {},
      steps: Object.fromEntries([...upstream].map(id => [id, { output: outputs[id] }])),
    };
    const evaluate = async (template: Template, path: string) => {
      try {
        return { value: await resolveTemplate(template, scope, path) };
      } catch (error) {
        return { problem: `Could not resolve ${path}: ${(error as Error).message}` };
      }
    };

    if (when) {
      const { value, problem } = await evaluate(when, 'when');
      if (problem) return fail(problem);
      if (!isTruthy(value)) return skip('when was false');
    }
    if (!forEach) return [newStepRun(base)];

    const { value: listed, problem } = await evaluate(forEach, 'forEach');
    if (problem) return fail(problem);
    // JSONata gives a lone match as a value and no match as undefined; both mean a list here
    const list = listed === undefined ? [] : Array.isArray(listed) ? listed : [listed];
    if (list.length > MAX_FOR_EACH_ITEMS) return fail(`forEach produced ${list.length} items; the limit is ${MAX_FOR_EACH_ITEMS}`);

    // Items first: if this dies midway, the parent row is what marks the fan-out as planned
    const itemRows = list.map((item, index) => newStepRun({ ...base, index, item }));
    await this.deps.store.insertStepRuns(itemRows);
    return [newStepRun({ ...base, fanOut: true, status: list.length ? 'RUNNING' : 'SUCCEEDED', startedAt: now, ...(list.length ? {} : { output: [], iterations: 0, endedAt: now }) })];
  }

  /** After a failure nothing new starts; what is already running is left to finish */
  private async skipAfterFailure(rows: StepRun[]): Promise<boolean> {
    if (!rows.some(isFailure)) return false;
    let changed = false;
    for (const row of rows) {
      if (!['PENDING', 'QUEUED', 'WAITING'].includes(row.status)) continue;
      const skipped = await this.deps.store.updateStepRun(
        row.id,
        { status: ['PENDING', 'QUEUED', 'WAITING'] },
        { status: 'SKIPPED', reason: SKIP_AFTER_FAILURE }
      );
      if (skipped) changed = true;
    }
    return changed;
  }

  /** Writes the timeline events the rows have moved past. Times come from the rows, so they stay accurate. */
  private async report(run: RunSummary, steps: Map<string, CompiledStep>, mine: Map<string, StepRun>): Promise<boolean> {
    const { store } = this.deps;
    let summary = run;
    let wrote = false;

    for (const stepId of steps.keys()) {
      const row = mine.get(stepId);
      const shown = () => summary.steps.find(step => step.id === stepId);
      if (!row || !shown()) continue;

      if (shown().status === 'PENDING' && row.startedAt) {
        summary = await appendRunEvent(store, run.id, 'StepStarted', { stepId, task: row.task }, new Date(row.startedAt));
        wrote = true;
      }
      if (!isFinished(row) || !['PENDING', 'RUNNING'].includes(shown().status)) continue;

      const at = new Date(row.endedAt ?? Date.now());
      if (row.status === 'SUCCEEDED') {
        const output = (await store.getStepOutputs(run.id, [stepId]))[stepId];
        summary = await appendRunEvent(store, run.id, 'StepSucceeded', { stepId, output: capOutput(output), iterations: row.iterations }, at);
      } else if (isFailure(row)) {
        const deadLettered = row.status === 'DEAD_LETTERED' ? true : undefined;
        summary = await appendRunEvent(store, run.id, 'StepFailed', { stepId, error: row.error, deadLettered }, at);
      } else {
        summary = await appendRunEvent(store, run.id, 'StepSkipped', { stepId, reason: row.reason }, at);
      }
      wrote = true;
    }
    return wrote;
  }

  /** Queues work that is ready. The job goes first: enqueueing is idempotent, so a crash here only repeats it. */
  private async admit(rows: StepRun[]): Promise<void> {
    const { store, queue, signals } = this.deps;
    const busy = new Set(rows.filter(row => row.index !== undefined && ['QUEUED', 'RUNNING', 'WAITING'].includes(row.status)).map(row => row.stepId));
    let admitted = false;

    for (const row of rows.filter(r => r.status === 'PENDING').sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
      // One forEach item at a time, in order; parallel fan-out comes in B4
      if (row.index !== undefined) {
        if (busy.has(row.stepId)) continue;
        busy.add(row.stepId);
      }
      await queue.enqueue({ id: row.id, runId: row.runId });
      await store.updateStepRun(row.id, { status: ['PENDING'] }, { status: 'QUEUED' });
      admitted = true;
    }
    if (admitted) signals.jobsAvailable();
  }

  /** Closes the run once every step has finished */
  private async finish(run: RunSummary, steps: Map<string, CompiledStep>, rows: StepRun[], mine: Map<string, StepRun>): Promise<boolean> {
    const { store } = this.deps;
    const everyStep = [...steps.keys()].every(id => mine.has(id) && isFinished(mine.get(id)));
    if (!everyStep || !rows.every(isFinished)) return false;

    const failed = [...steps.keys()].map(id => mine.get(id)).find(isFailure);
    if (failed) await appendRunEvent(store, run.id, 'RunFailed', { failedStepId: failed.stepId, error: failed.error });
    else await appendRunEvent(store, run.id, 'RunSucceeded', {});
    return false;
  }
}

