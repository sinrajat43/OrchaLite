/** Nest injection token for the StepQueue */
export const STEP_QUEUE = Symbol('STEP_QUEUE');

/** A job only names the row to work on; all state stays with the row */
export interface StepJob {
  /** The step run id, which also deduplicates the job */
  id: string;
  runId: string;
}

/** A job held under a lease */
export interface Claim {
  job: StepJob;
  /** Proves this holder still owns the lease; a redelivery gets a new one */
  token: string;
}

/**
 * Hands out work with at-least-once delivery. A claimed job is invisible for
 * its lease; if it is not extended or acknowledged in time, it comes back and
 * another worker gets it. MongoDB by default; swappable because the engine only
 * talks to this interface.
 */
export interface StepQueue {
  /** Adds a job; does nothing if one with this id is already queued */
  enqueue(job: StepJob, availableAt?: Date): Promise<void>;
  /** The next visible job, oldest first, or null if there is none */
  claim(workerId: string, leaseMs: number): Promise<Claim | null>;
  /** @returns false if the lease was lost */
  extend(claim: Claim, leaseMs: number): Promise<boolean>;
  /** The work is done: removes the job, if this holder still owns it */
  ack(claim: Claim): Promise<void>;
  /** Gives the job back, to be delivered at availableAt (now by default) */
  release(claim: Claim, availableAt?: Date): Promise<void>;
  /** For monitoring: jobs ready to claim, delayed until later, and leased to a worker */
  depth(): Promise<{ ready: number; delayed: number; leased: number }>;
}
