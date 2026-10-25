import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Types } from 'mongoose';
import { RunHooks, WorkflowStep } from '../orchestrator/task-runner.util';
import { TaskExecutionError } from '../tasks/task.interface';
import { applyEvent, replay } from './run-projection';
import { RUN_STORE, RunStore } from './run-store';
import { RunEvent, RunEventType, RunSummary } from './run.types';

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
 * Storage errors are logged, never thrown, so a history outage cannot fail a
 * workflow; it shows up as a gap in the run's seq numbers instead.
 */
export class RunHandle {
  private seq = 0;
  private summary: RunSummary | null = null;

  constructor(readonly runId: string, private readonly store: RunStore) {}

  /** Callbacks to pass to runWorkflow */
  readonly hooks: RunHooks = {
    onStepStarted: step => this.record('StepStarted', { stepId: step.id, task: step.task, params: step.params }),
    onStepSucceeded: (step, output) => this.record('StepSucceeded', { stepId: step.id, output: capOutput(output) }),
    onStepFailed: (step, error) => this.record('StepFailed', { stepId: step.id, error: error.message }),
  };

  async start(definition: { name: string; steps: WorkflowStep[] }): Promise<void> {
    await this.record('RunStarted', { definition });
  }

  async succeed(): Promise<void> {
    await this.record('RunSucceeded', {});
  }

  async fail(error: Error): Promise<void> {
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
  }

  async abandon(reason: string): Promise<void> {
    await this.record('RunAbandoned', { error: reason });
  }

  private async skipPendingSteps(): Promise<void> {
    for (const step of this.summary?.steps ?? []) {
      if (step.status === 'PENDING') {
        await this.record('StepSkipped', { stepId: step.id, reason: 'upstream failed' });
      }
    }
  }

  private async record(type: RunEventType, data: Record<string, any>): Promise<void> {
    const event: RunEvent = { runId: this.runId, seq: ++this.seq, type, at: new Date(), data };
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

  async start(definition: { name: string; steps: WorkflowStep[] }): Promise<RunHandle> {
    const handle = new RunHandle(new Types.ObjectId().toHexString(), this.store);
    await handle.start(definition);
    return handle;
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
