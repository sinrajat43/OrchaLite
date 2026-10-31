import { Injectable } from '@nestjs/common';

type Listener<T> = (value: T) => void;

/**
 * Nudges between a scheduler and workers in the same process, so a step does not
 * wait for the next poll. Only an optimisation: across processes, and whenever a
 * nudge is missed, polling does the same job.
 */
@Injectable()
export class EngineSignals {
  private readonly runListeners = new Set<Listener<string>>();
  private readonly jobListeners = new Set<Listener<void>>();

  /** Something about this run changed: a step finished, or it was just accepted */
  runChanged(runId: string): void {
    this.runListeners.forEach(listener => listener(runId));
  }

  jobsAvailable(): void {
    this.jobListeners.forEach(listener => listener());
  }

  onRunChanged(listener: Listener<string>): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  onJobsAvailable(listener: Listener<void>): () => void {
    this.jobListeners.add(listener);
    return () => this.jobListeners.delete(listener);
  }
}
