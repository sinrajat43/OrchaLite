import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Types } from 'mongoose';
import { RunHooks } from '../orchestrator/task-runner.util';
import { WorkflowDefinition } from '../orchestrator/workflow-definition';
import { TaskExecutionError } from '../tasks/task.interface';
import { applyEvent, replay } from './run-projection';
import { RUN_STORE, RunStore } from './run-store';
import { RunEvent, RunEventType, RunSummary, WorkflowRef } from './run.types';

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
  private seq = 0;
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

  /** Continues an existing timeline, e.g. to close a run left behind by a crash */
  resumeFrom(events: RunEvent[], stored: RunSummary): void {
    // Falls back to the stored summary if its events were never written
    this.summary = replay(events) ?? stored;
    this.seq = events.reduce((max, e) => Math.max(max, e.seq), stored.lastSeq);
    this.hasStarted = true;
  }

  async abandon(reason: string): Promise<void> {
    await this.record('RunAbandoned', { error: reason });
  }

  private async skipPendingSteps(): Promise<void> {
    for (const step of this.summary?.steps ?? []) {
      if (step.status === 'PENDING') {
        await this.record('StepSkipped', { stepId: step.id, reason: 'an earlier step failed' });
      }
    }
  }

  private async record(type: RunEventType, data: Record<string, any>): Promise<void> {
    // Undefined fields are dropped so the stored event matches what replay sees
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    const event: RunEvent = { runId: this.runId, seq: ++this.seq, type, at: new Date(), data: clean };
    try {
      this.summary = applyEvent(this.summary, event);
      // Event first: if the process dies before the summary write, replaying events repairs it
      await this.store.appendEvent(event);
      await this.store.saveSummary(this.summary);
    } catch (error) {
      console.error(`Run history: failed to record ${type} (seq ${event.seq}) for run ${this.runId}:`, error);
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
   * Runs only live inside a request, so any run still RUNNING at startup
   * belongs to a process that died. Repair its summary from the events and
   * close it as ABANDONED.
   */
  async abandonUnfinishedRuns(): Promise<string[]> {
    const abandoned: string[] = [];
    for (const run of await this.store.findRunning()) {
      try {
        const handle = new RunHandle(run.id, this.store);
        handle.resumeFrom(await this.store.getEvents(run.id), run);
        await handle.abandon('The server stopped while this run was in progress');
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
