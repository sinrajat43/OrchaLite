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
  /** Inserts or replaces the summary for summary.id */
  saveSummary(summary: RunSummary): Promise<void>;
  /** Newest first */
  listRuns(query: RunQuery): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunSummary | null>;
  /** Oldest first */
  getEvents(runId: string): Promise<RunEvent[]>;
  findRunning(): Promise<RunSummary[]>;
}

export class DuplicateEventError extends Error {
  constructor(runId: string, seq: number) {
    super(`Run ${runId} already has an event with seq ${seq}`);
    this.name = 'DuplicateEventError';
  }
}
