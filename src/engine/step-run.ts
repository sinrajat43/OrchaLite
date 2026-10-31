/**
 * The state of one unit of work. Unlike run events, these rows are mutable and
 * every change is a conditional update, because workers and the scheduler race
 * on them.
 *
 *   PENDING -> QUEUED -> RUNNING -> SUCCEEDED | FAILED
 *                           ^  |  \\
 *                           |  v   DEAD_LETTERED
 *                         WAITING
 *
 * WAITING is a retry's backoff or a task's stored wait. PENDING, QUEUED and
 * WAITING can also move to SKIPPED when an earlier step fails.
 */
export type StepRunStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTERED' | 'SKIPPED';

export const FINISHED_STEP_RUN: StepRunStatus[] = ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'SKIPPED'];

export const isFinished = (row: Pick<StepRun, 'status'>): boolean => FINISHED_STEP_RUN.includes(row.status);

/** Both end the run; a dead letter is work that could have succeeded, kept for an operator to look at */
export const isFailure = (row: Pick<StepRun, 'status'>): boolean => row.status === 'FAILED' || row.status === 'DEAD_LETTERED';

/** One attempt that failed with a retryable error */
export interface StepFailureRecord {
  attempt: number;
  error: string;
  at: Date;
}

export interface StepRun {
  /** runId:stepId, plus :index for one item of a forEach step */
  id: string;
  runId: string;
  stepId: string;
  task: string;
  /** The workflow's name, for limits that span its runs */
  workflow?: string;
  /** Copied from the definition when the row is created, so admission does not need the definition */
  stepLimit?: number;
  workflowLimit?: number;
  /** Set on one item of a forEach step */
  index?: number;
  item?: unknown;
  /** This row undoes step stepId, after a later step failed */
  compensation?: boolean;
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
  /** A WAITING row is not worked on before this time */
  notBefore?: Date;
  /** The task asked to wait and that wait is over or under way */
  resumed?: boolean;
  /** Times this row gave up its worker on purpose, for a stored wait or a rate limit */
  yields?: number;
  /** Retryable failures so far, oldest first; the next attempt is one more than their number */
  failures?: StepFailureRecord[];
  startedAt?: Date;
  endedAt?: Date;
}

export const stepRunId = (runId: string, stepId: string, index?: number): string =>
  index === undefined ? `${runId}:${stepId}` : `${runId}:${stepId}:${index}`;

export const compensationId = (runId: string, stepId: string): string => `${stepRunId(runId, stepId)}:compensate`;

/** A new row, before anything has happened to it */
export function newStepRun(fields: Pick<StepRun, 'runId' | 'stepId' | 'task'> & Partial<StepRun>): StepRun {
  return { id: stepRunId(fields.runId, fields.stepId, fields.index), status: 'PENDING', version: 1, fence: 0, ...fields };
}

/** How much work one group of rows has in flight */
export interface InFlightCount {
  runId: string;
  stepId: string;
  task: string;
  workflow?: string;
  count: number;
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
