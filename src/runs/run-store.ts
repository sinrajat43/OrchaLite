import { InFlightCount, StepRun, StepRunExpectation, StepRunUpdateOptions } from '../engine/step-run';
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
  /** Every run the scheduler still has work to do on */
  findRunning(): Promise<RunSummary[]>;

  /** Adds rows, leaving any that already exist as they are */
  insertStepRuns(rows: StepRun[]): Promise<void>;
  getStepRun(id: string): Promise<StepRun | null>;
  /** Every row of a run, without outputs or items, which can be large */
  listStepRuns(runId: string): Promise<StepRun[]>;
  /** Outputs of the named steps, by step id */
  getStepOutputs(runId: string, stepIds?: string[]): Promise<Record<string, unknown>>;
  /** Outputs of a forEach step's items, in order */
  getItemOutputs(runId: string, stepId: string): Promise<unknown[]>;
  /**
   * Applies changes only if the row still meets the expectation, as one atomic
   * step, and raises its version
   * @returns the updated row, or null if the expectation failed and nothing changed
   */
  updateStepRun(id: string, expected: StepRunExpectation, changes: Partial<StepRun>, options?: StepRunUpdateOptions): Promise<StepRun | null>;
  /** Removes the rows of a run that did not succeed, so they can run again */
  deleteUnfinishedWork(runId: string): Promise<void>;
  countActiveRuns(): Promise<number>;
  /** PENDING rows, up to perRun of each run with any, lowest forEach index first, without outputs */
  listPending(perRun: number): Promise<StepRun[]>;
  /**
   * What holds a slot: rows queued, running, or backing off before a retry. A
   * stored wait holds none, since it uses no worker. A forEach step's own row
   * does no work, so it does not count.
   */
  countInFlight(): Promise<InFlightCount[]>;
  /** The outbox: oldest first, at most limit */
  listUnpublishedEvents(limit: number): Promise<RunEvent[]>;
  markEventsPublished(events: RunEvent[]): Promise<void>;
  /** Newest first, without outputs */
  listDeadLetters(limit: number): Promise<StepRun[]>;
  /**
   * Claims an idempotency key for a run, atomically
   * @returns the request now holding the key: this one, or an earlier one to reuse
   */
  claimRunRequest(request: RunRequest): Promise<RunRequest>;
}

/** Ties an idempotency key to the run it started */
export interface RunRequest {
  key: string;
  /** Identifies what was asked for, so a key reused for something else can be refused */
  fingerprint: string;
  runId: string;
}

export class DuplicateEventError extends Error {
  constructor(runId: string, seq: number) {
    super(`Run ${runId} already has an event with seq ${seq}`);
    this.name = 'DuplicateEventError';
  }
}
