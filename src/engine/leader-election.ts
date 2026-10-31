import { Logger } from '@nestjs/common';
import { LeaderLock } from './leader-lock';

const LOCK_NAME = 'scheduler';

/**
 * Keeps trying for the leader lock, and renews it while held. Leadership ends
 * early if a renewal fails, in case another process has taken over.
 */
export class LeaderElection {
  private readonly logger = new Logger(LeaderElection.name);
  private timer?: NodeJS.Timeout;
  private leader = false;
  private checking?: Promise<void>;

  constructor(
    private readonly lock: LeaderLock,
    private readonly owner: string,
    private readonly ttlMs: number
  ) {}

  get isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    await this.check();
    this.timer = setInterval(() => {
      this.checking ??= this.check().finally(() => (this.checking = undefined));
    }, Math.max(1, Math.floor(this.ttlMs / 3)));
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.checking;
    if (this.leader) await this.lock.release(LOCK_NAME, this.owner).catch(() => undefined);
    this.leader = false;
  }

  private async check(): Promise<void> {
    let held = false;
    try {
      held = await this.lock.acquire(LOCK_NAME, this.owner, this.ttlMs);
    } catch (error) {
      this.logger.warn(`Could not check the leader lock: ${(error as Error).message}`);
    }
    if (held !== this.leader) this.logger.log(`${this.owner} ${held ? 'is now' : 'is no longer'} the leader`);
    this.leader = held;
  }
}
