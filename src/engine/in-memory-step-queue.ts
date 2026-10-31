import { randomUUID } from 'crypto';
import { Claim, StepJob, StepQueue } from './step-queue';

/**
 * StepQueue kept in process memory, for tests
 */
export class InMemoryStepQueue implements StepQueue {
  private readonly jobs = new Map<string, { job: StepJob; visibleAt: number; token?: string; order: number }>();
  private order = 0;

  async enqueue(job: StepJob, availableAt = new Date()): Promise<void> {
    if (!this.jobs.has(job.id)) this.jobs.set(job.id, { job, visibleAt: availableAt.getTime(), order: this.order++ });
  }

  async claim(_workerId: string, leaseMs: number): Promise<Claim | null> {
    const now = Date.now();
    const [next] = [...this.jobs.values()]
      .filter(entry => entry.visibleAt <= now)
      .sort((a, b) => a.visibleAt - b.visibleAt || a.order - b.order);
    if (!next) return null;
    next.token = randomUUID();
    next.visibleAt = now + leaseMs;
    return { job: next.job, token: next.token };
  }

  async extend({ job, token }: Claim, leaseMs: number): Promise<boolean> {
    const entry = this.jobs.get(job.id);
    if (entry?.token !== token) return false;
    entry.visibleAt = Date.now() + leaseMs;
    return true;
  }

  async ack({ job, token }: Claim): Promise<void> {
    if (this.jobs.get(job.id)?.token === token) this.jobs.delete(job.id);
  }

  async release({ job, token }: Claim, availableAt = new Date()): Promise<void> {
    const entry = this.jobs.get(job.id);
    if (entry?.token !== token) return;
    entry.token = undefined;
    entry.visibleAt = availableAt.getTime();
  }

  async depth(): Promise<{ ready: number; delayed: number; leased: number }> {
    const now = Date.now();
    const entries = [...this.jobs.values()];
    return {
      ready: entries.filter(e => e.visibleAt <= now).length,
      delayed: entries.filter(e => e.visibleAt > now && !e.token).length,
      leased: entries.filter(e => e.visibleAt > now && e.token).length,
    };
  }
}
