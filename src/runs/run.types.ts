export const RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED'] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTERED' | 'SKIPPED';

export type RunEventType =
  | 'RunStarted'
  | 'StepStarted'
  | 'StepRetryScheduled'
  | 'StepSucceeded'
  | 'StepFailed'
  | 'StepSkipped'
  | 'RunSucceeded'
  | 'RunFailed'
  | 'RunAbandoned';

/**
 * One immutable entry in a run's timeline. Events are the source of truth;
 * the run summary is derived from them.
 */
export interface RunEvent {
  runId: string;
  /** 1, 2, 3... per run; (runId, seq) is unique */
  seq: number;
  type: RunEventType;
  at: Date;
  data: Record<string, any>;
}

export interface StepSummary {
  id: string;
  task: string;
  status: StepStatus;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  error?: string;
  /** Why a SKIPPED step did not run */
  reason?: string;
  /** forEach steps: how many items ran */
  iterations?: number;
  /** Failed attempts that were retried, across all items */
  retries?: number;
}

/** The stored workflow version a run came from */
export interface WorkflowRef {
  name: string;
  version: number;
}

/**
 * Read model for listing and inspecting runs, rebuilt by replaying events
 */
export interface RunSummary {
  /** Time-sortable id (ObjectId hex) */
  id: string;
  name: string;
  status: RunStatus;
  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;
  /** Snapshot of the workflow as it ran */
  definition: { name: string; input?: Record<string, unknown>; steps: any[] };
  /** Run input, with defaults filled in */
  input?: Record<string, unknown>;
  /** Set when the run came from a stored workflow */
  workflow?: WorkflowRef;
  /** Set on runs driven by the scheduler and workers; older runs have no step rows */
  execution?: 'queue';
  failedStepId?: string;
  error?: string;
  steps: StepSummary[];
  /** Seq of the last event applied to this summary */
  lastSeq: number;
}

export interface RunQuery {
  status?: RunStatus;
  name?: string;
  limit: number;
  /** Only runs older than this run id (cursor pagination) */
  before?: string;
}
