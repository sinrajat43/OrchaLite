import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Claim, StepJob, StepQueue } from './step-queue';

const QUEUE_NAME = 'orchalite-steps';

/** Set high because the engine counts lost deliveries itself; BullMQ would otherwise fail the job quietly */
const MAX_STALLED = 1_000_000;

/** BullMQ reports a lost lock by throwing; the port says doing nothing is fine in that case */
const LOST_LOCK = /Missing (key|lock)|Lock mismatch|not in the active state/;

/**
 * StepQueue on BullMQ and Redis, using its manual fetch mode so the worker loop,
 * leases and fencing stay the engine's own.
 *
 * It differs from the MongoDB queue in two ways the engine has to allow for:
 * - A dead worker's job comes back after a stalled check notices the lock is
 *   gone, so up to two stalled intervals after the lease, not exactly at its end.
 * - Redis can lose jobs if it is not persisting. Rows stay in MongoDB, so the
 *   scheduler puts lost jobs back; see Scheduler.restoreJobs.
 */
export class BullMqStepQueue implements StepQueue {
  private readonly logger = new Logger(BullMqStepQueue.name);
  private readonly connection: IORedis;
  private readonly queue: Queue;
  /** A BullMQ worker has one lock duration, so there is one per lease length, usually just one */
  private readonly workers = new Map<number, Worker>();

  constructor(url: string, private readonly stalledIntervalMs: number) {
    // BullMQ needs commands to wait through a reconnect rather than fail
    this.connection = new IORedis(url, { maxRetriesPerRequest: null });
    this.connection.on('error', error => this.report(error));
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection, defaultJobOptions: { removeOnComplete: true, removeOnFail: true } });
    this.queue.on('error', error => this.report(error));
  }

  async enqueue({ id, runId }: StepJob, availableAt = new Date()): Promise<void> {
    // A job with this id already there means this add does nothing, which is what the port promises
    await this.queue.add('step', { id, runId }, { jobId: jobIdOf(id), delay: Math.max(0, availableAt.getTime() - Date.now()) });
  }

  async claim(_workerId: string, leaseMs: number): Promise<Claim | null> {
    const token = randomUUID();
    const job = await this.workerFor(leaseMs).getNextJob(token, { block: false });
    return job ? { job: job.data as StepJob, token } : null;
  }

  async extend({ job, token }: Claim, leaseMs: number): Promise<boolean> {
    const found = await this.find(job);
    if (!found) return false;
    try {
      return (await found.extendLock(token, leaseMs)) > 0;
    } catch (error) {
      if (LOST_LOCK.test((error as Error).message)) return false;
      throw error;
    }
  }

  async ack({ job, token }: Claim): Promise<void> {
    await this.ifStillHeld(job, found => found.moveToCompleted(null, token, false));
  }

  async release({ job, token }: Claim, availableAt?: Date): Promise<void> {
    await this.ifStillHeld(job, found => (availableAt && availableAt.getTime() > Date.now() ? found.moveToDelayed(availableAt.getTime(), token) : found.moveToWait(token)));
  }

  async depth(): Promise<{ ready: number; delayed: number; leased: number }> {
    const { waiting, delayed, active } = await this.queue.getJobCounts('waiting', 'delayed', 'active');
    return { ready: waiting, delayed, leased: active };
  }

  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map(worker => worker.close()));
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  private find({ id }: StepJob): Promise<Job | undefined> {
    return Job.fromId(this.queue, jobIdOf(id));
  }

  private async ifStillHeld(job: StepJob, action: (found: Job) => Promise<unknown>): Promise<void> {
    const found = await this.find(job);
    if (!found) return;
    try {
      await action(found);
    } catch (error) {
      if (!LOST_LOCK.test((error as Error).message)) throw error;
    }
  }

  private workerFor(leaseMs: number): Worker {
    let worker = this.workers.get(leaseMs);
    if (worker) return worker;
    worker = new Worker(QUEUE_NAME, null, {
      connection: this.connection,
      autorun: false,
      lockDuration: leaseMs,
      stalledInterval: this.stalledIntervalMs,
      maxStalledCount: MAX_STALLED,
    });
    worker.on('error', error => this.report(error));
    // Manual mode does not start the check that returns a dead worker's jobs
    void worker.startStalledCheckTimer().catch(error => this.report(error));
    this.workers.set(leaseMs, worker);
    return worker;
  }

  private report(error: Error): void {
    this.logger.warn(`Redis: ${error.message}`);
  }
}

/** BullMQ forbids ":" in job ids, and every row id has one */
const jobIdOf = (id: string): string => `step-${encodeURIComponent(id)}`;
