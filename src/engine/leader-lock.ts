import { Model, model, models, Schema } from 'mongoose';

/** Nest injection token for the LeaderLock */
export const LEADER_LOCK = Symbol('LEADER_LOCK');

/**
 * Lets one of several processes act as the leader: a named lease, renewed by
 * its holder, that anyone can take once it has run out. Leadership can overlap
 * briefly if a leader stalls past its lease, so nothing it does may rely on being
 * the only one: cron firings are deduplicated by key, and scheduling is idempotent.
 */
export interface LeaderLock {
  /** Takes or renews the lock. @returns true if owner now holds it */
  acquire(name: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Gives it up at once, so a clean shutdown does not cost a full lease */
  release(name: string, owner: string): Promise<void>;
}

export class InMemoryLeaderLock implements LeaderLock {
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>();

  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const lock = this.locks.get(name);
    if (lock && lock.owner !== owner && lock.expiresAt > now) return false;
    this.locks.set(name, { owner, expiresAt: now + ttlMs });
    return true;
  }

  async release(name: string, owner: string): Promise<void> {
    if (this.locks.get(name)?.owner === owner) this.locks.delete(name);
  }
}

const LockSchema = new Schema({ _id: { type: String }, owner: String, expiresAt: Date }, { versionKey: false });
const LockModel: Model<any> = models.EngineLock ?? model('EngineLock', LockSchema, 'engine_locks');

export class MongoLeaderLock implements LeaderLock {
  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    try {
      // Matches if it is free, expired or already ours; otherwise the upsert hits the _id index
      await LockModel.updateOne(
        { _id: name, $or: [{ owner }, { expiresAt: { $lte: now } }] },
        { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
        { upsert: true }
      );
      return true;
    } catch (error) {
      if ((error as any)?.code === 11000) return false;
      throw error;
    }
  }

  async release(name: string, owner: string): Promise<void> {
    await LockModel.deleteOne({ _id: name, owner });
  }
}
