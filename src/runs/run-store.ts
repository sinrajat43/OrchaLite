import { RunEvent, RunQuery, RunSummary } from './run.types';

/** Nest injection token for the RunStore */
export const RUN_STORE = Symbol('RUN_STORE');

/**
 * Where run history is kept. The recorder and the API only talk to this
 * interface, so the backend can be swapped (MongoDB today, in-memory in tests).
 */
export interface RunStore {
  /** Adds an event; rejects if (runId, seq) already exists */
  appendEvent(event: RunEvent): Promise<void>;
  /**
   * Replaces the summary only if its stored lastSeq is still expectedLastSeq
   * (0 for a run with no summary yet): a conditional update, so a writer working
   * from an old copy cannot overwrite a newer one.
   * @returns false if the version check failed and nothing was written
   */
  saveSummary(summary: RunSummary, expectedLastSeq: number): Promise<boolean>;
  /** Newest first */
  listRuns(query: RunQuery): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunSummary | null>;
  /** Oldest first, optionally only those after a seq */
  getEvents(runId: string, afterSeq?: number): Promise<RunEvent[]>;
  findRunning(): Promise<RunSummary[]>;
}

export class DuplicateEventError extends Error {
  constructor(runId: string, seq: number) {
    super(`Run ${runId} already has an event with seq ${seq}`);
    this.name = 'DuplicateEventError';
  }
}
