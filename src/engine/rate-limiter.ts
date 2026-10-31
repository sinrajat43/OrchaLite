import { Model, model, models, Schema } from 'mongoose';

/** Nest injection token for the RateLimiter */
export const RATE_LIMITER = Symbol('RATE_LIMITER');

/**
 * Thrown when a call is not allowed yet. The worker gives up the step's slot and
 * the job comes back after the wait, so a slow limit cannot tie up every worker.
 */
export class RateLimited extends Error {
  constructor(readonly waitMs: number) {
    super(`Rate limited for ${waitMs} ms`);
    this.name = 'RateLimited';
  }
}

/**
 * Rate limits shared by every worker, using the generic cell rate algorithm:
 * one timestamp per key, the time at which the limiter is idle again (the
 * "theoretical arrival time"). A call is allowed if that time is no further
 * ahead than the burst allows, and pushes it forward by one interval.
 */
export interface RateLimiter {
  /** @returns 0 if the call may go ahead now, otherwise how many ms to wait before asking again */
  acquire(key: string, perSecond: number, burst: number): Promise<number>;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly idleAt = new Map<string, number>();

  async acquire(key: string, perSecond: number, burst: number): Promise<number> {
    const now = Date.now();
    const interval = 1000 / perSecond;
    const idleAt = Math.max(this.idleAt.get(key) ?? 0, now);
    const allowedAhead = interval * (burst - 1);
    if (idleAt - now > allowedAhead) return Math.ceil(idleAt - allowedAhead - now);
    this.idleAt.set(key, idleAt + interval);
    return 0;
  }
}

const RateLimitSchema = new Schema({ _id: { type: String }, idleAt: Date }, { versionKey: false });
const RateLimitModel: Model<any> = models.RateLimit ?? model('RateLimit', RateLimitSchema, 'rate_limits');

export class MongoRateLimiter implements RateLimiter {
  async acquire(key: string, perSecond: number, burst: number): Promise<number> {
    const now = new Date();
    const interval = 1000 / perSecond;
    const allowedAhead = interval * (burst - 1);
    try {
      // One atomic update: it matches only if a call is allowed. Without a match
      // the upsert tries to insert the same _id, and that failure means "not yet".
      await RateLimitModel.updateOne(
        { _id: key, idleAt: { $lte: new Date(now.getTime() + allowedAhead) } },
        [{ $set: { idleAt: { $add: [{ $max: ['$idleAt', now] }, interval] } } }],
        { upsert: true }
      );
      return 0;
    } catch (error) {
      if ((error as any)?.code !== 11000) throw error;
    }
    const limit: any = await RateLimitModel.findById(key).lean();
    return Math.max(1, Math.ceil(new Date(limit.idleAt).getTime() - allowedAhead - now.getTime()));
  }
}
