import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Types } from 'mongoose';
import { RunHooks } from '../orchestrator/task-runner.util';
import { WorkflowDefinition } from '../orchestrator/workflow-definition';
import { TaskExecutionError } from '../tasks/task.interface';
import { applyEvent } from './run-projection';
import { DuplicateEventError, RUN_STORE, RunStore } from './run-store';
import { RunEvent, RunEventType, RunSummary, WorkflowRef } from './run.types';

const MAX_APPEND_ATTEMPTS = 10;

/**
 * Appends an event to a run with optimistic concurrency: read the version
 * (lastSeq), claim the next seq through the unique (runId, seq) index, and on a
 * collision start over from the newer state. Any number of writers can share a run.
 * A summary left behind by a crash between the two writes is caught up from the
 * events first, so it repairs itself on the next append.
 * @throws IllegalTransitionError if the run's state machine does not allow the event
 */
export async function appendRunEvent(store: RunStore, runId: string, type: RunEventType, data: Record<string, any>, at = new Date()): Promise<RunSummary> {
  // Undefined fields are dropped so the stored event matches what replay sees
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const stored = await store.getRun(runId);
    const storedSeq = stored?.lastSeq ?? 0;
    const current = (await store.getEvents(runId, storedSeq)).reduce<RunSummary | null>(applyEvent, stored);
    const event: RunEvent = { runId, seq: (current?.lastSeq ?? 0) + 1, type, at, data: clean };
    const next = applyEvent(current, event);
    try {
      // Event first: if the process dies before the summary write, the next append repairs it
      await store.appendEvent(event);
    } catch (error) {
      if (error instanceof DuplicateEventError) continue;
      throw error;
    }
    // A failed check means another writer already moved the summary on; the events still hold this one
    await store.saveSummary(next, storedSeq);
    return next;
  }
  throw new Error(`Run ${runId}: gave up appending ${type} after ${MAX_APPEND_ATTEMPTS} conflicts`);
}

/** Step outputs larger than this are stored as a preview only */
export const MAX_OUTPUT_BYTES = 256 * 1024;
const PREVIEW_CHARS = 2000;

/**
 * Shapes a step output for storage, replacing anything over the cap with a preview
 */
export function capOutput(output: any): any {
  if (output === undefined) return undefined;
  const json = JSON.stringify(output);
  const sizeBytes = Buffer.byteLength(json ?? '');
  if (sizeBytes <= MAX_OUTPUT_BYTES) return output;
  return { truncated: true, sizeBytes, preview: json.slice(0, PREVIEW_CHARS) };
}

/**
 * Records one run: every call appends the next event and updates the summary.
 * Nothing is written until the runner reports that the run started, so a
 * definition or input the engine rejects never becomes a run.
 * Storage errors are logged, never thrown, so a history outage cannot fail a
 * workflow; it shows up as a gap in the run's seq numbers instead.
 */
export class RunHandle {
  private summary: RunSummary | null = null;
  private hasStarted = false;

  constructor(
    readonly runId: string,
    private readonly store: RunStore,
    private readonly definition?: WorkflowDefinition,
    private readonly workflow?: WorkflowRef
  ) {}

  /** True once RunStarted was recorded */
  get started(): boolean {
    return this.hasStarted;
  }

  /** Callbacks to pass to runWorkflow */
  readonly hooks: RunHooks = {
    onRunStarted: async input => {
      this.hasStarted = true;
      await this.record('RunStarted', { definition: this.definition, input, workflow: this.workflow });
    },
    onStepStarted: step => this.record('StepStarted', { stepId: step.id, task: step.task }),
    onStepFinished: (step, result) =>
      result.status === 'skipped'
        ? this.record('StepSkipped', { stepId: step.id, reason: result.reason })
        : this.record('StepSucceeded', { stepId: step.id, output: capOutput(result.output), iterations: result.iterations }),
    onStepFailed: (step, error) => this.record('StepFailed', { stepId: step.id, error: error.message }),
  };

  async succeed(): Promise<void> {
    if (this.hasStarted) await this.record('RunSucceeded', {});
  }

  async fail(error: Error): Promise<void> {
    if (!this.hasStarted) return;
    await this.skipPendingSteps();
    await this.record('RunFailed', {
      failedStepId: error instanceof TaskExecutionError ? error.taskId : undefined,
      error: error.message,
    });
  }

  private async skipPendingSteps(): Promise<void> {
    for (const step of this.summary?.steps ?? []) {
      if (step.status === 'PENDING') {
        await this.record('StepSkipped', { stepId: step.id, reason: 'an earlier step failed' });
      }
    }
  }

  private async record(type: RunEventType, data: Record<string, any>): Promise<void> {
    try {
      this.summary = await appendRunEvent(this.store, this.runId, type, data);
    } catch (error) {
      console.error(`Run history: failed to record ${type} for run ${this.runId}:`, error);
    }
  }
}

@Injectable()
export class RunRecorder implements OnApplicationBootstrap {
  constructor(@Inject(RUN_STORE) private readonly store: RunStore) {}

  /**
   * A handle for a run that is about to start. Pass its runId and hooks to
   * runWorkflow; it records nothing until the runner calls onRunStarted.
   */
  prepare(definition: WorkflowDefinition, workflow?: WorkflowRef): RunHandle {
    return new RunHandle(new Types.ObjectId().toHexString(), this.store, definition, workflow);
  }

  /**
   * Runs execute inside the process that started them, so any run still
   * RUNNING at startup belongs to a process that died. Close it as ABANDONED;
   * appending the event repairs its summary from the events.
   */
  async abandonUnfinishedRuns(): Promise<string[]> {
    const abandoned: string[] = [];
    for (const run of await this.store.findRunning()) {
      try {
        await appendRunEvent(this.store, run.id, 'RunAbandoned', { error: 'The server stopped while this run was in progress' });
        abandoned.push(run.id);
      } catch (error) {
        console.error(`Run history: could not close unfinished run ${run.id}:`, error);
      }
    }
    if (abandoned.length) console.log(`Run history: marked ${abandoned.length} unfinished run(s) as ABANDONED`);
    return abandoned;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.abandonUnfinishedRuns();
    } catch (error) {
      console.error('Run history: startup check for unfinished runs failed:', error);
    }
  }
}
