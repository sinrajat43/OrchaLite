/**
 * The state of one unit of work. Unlike run events, these rows are mutable and
 * every change is a conditional update, because workers and the scheduler race
 * on them.
 *
 *   PENDING -> QUEUED -> RUNNING -> SUCCEEDED | FAILED
 *                           ^  |
 *                           |  v
 *                         WAITING
 *
 * PENDING, QUEUED and WAITING can also move to SKIPPED when an earlier step fails.
 */
export type StepRunStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export const FINISHED_STEP_RUN: StepRunStatus[] = ['SUCCEEDED', 'FAILED', 'SKIPPED'];

export const isFinished = (row: Pick<StepRun, 'status'>): boolean => FINISHED_STEP_RUN.includes(row.status);

export interface StepRun {
  /** runId:stepId, plus :index for one item of a forEach step */
  id: string;
  runId: string;
  stepId: string;
  task: string;
  /** Set on one item of a forEach step */
  index?: number;
  item?: unknown;
  /** A forEach step's own row: it adds up its items and is never executed itself */
  fanOut?: boolean;
  status: StepRunStatus;
  /** Raised by every update */
  version: number;
  /**
   * Fencing token, raised each time a worker takes this row. A worker can only
   * commit under the value it got, so one that lost its lease and comes back
   * later cannot overwrite the worker that replaced it.
   */
  fence: number;
  output?: unknown;
  error?: string;
  /** Why a SKIPPED row did not run */
  reason?: string;
  /** fanOut rows: how many items ran */
  iterations?: number;
  /** A waiting task's wake-up time; it is resumed rather than started again */
  resumeAt?: Date;
  startedAt?: Date;
  endedAt?: Date;
}

export const stepRunId = (runId: string, stepId: string, index?: number): string =>
  index === undefined ? `${runId}:${stepId}` : `${runId}:${stepId}:${index}`;

/** A new row, before anything has happened to it */
export function newStepRun(fields: Pick<StepRun, 'runId' | 'stepId' | 'task'> & Partial<StepRun>): StepRun {
  return { id: stepRunId(fields.runId, fields.stepId, fields.index), status: 'PENDING', version: 1, fence: 0, ...fields };
}

/** What a conditional update requires of a row */
export interface StepRunExpectation {
  status?: StepRunStatus[];
  fence?: number;
}

export interface StepRunUpdateOptions {
  /** Raises the fencing token as part of the update */
  takeFence?: boolean;
}
