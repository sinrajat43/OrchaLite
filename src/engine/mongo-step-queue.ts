import { randomUUID } from 'crypto';
import { Model, model, models, Schema } from 'mongoose';
import { Claim, StepJob, StepQueue } from './step-queue';

const QueuedJobSchema = new Schema(
  {
    _id: { type: String },
    runId: { type: String, required: true },
    // A job is visible once this has passed. Claiming moves it forward by the
    // lease, so a job whose worker died simply becomes visible again.
    visibleAt: { type: Date, required: true },
    token: String,
    owner: String,
  },
  { versionKey: false }
);
QueuedJobSchema.index({ visibleAt: 1 });

const QueuedJobModel: Model<any> = models.QueuedJob ?? model('QueuedJob', QueuedJobSchema, 'step_queue');

/**
 * StepQueue on MongoDB, with the visibility-timeout model SQS uses. Claiming is
 * one atomic findOneAndUpdate, so two workers can never get the same delivery.
 */
export class MongoStepQueue implements StepQueue {
  async enqueue({ id, runId }: StepJob, availableAt = new Date()): Promise<void> {
    try {
      await QueuedJobModel.updateOne({ _id: id }, { $setOnInsert: { runId, visibleAt: availableAt } }, { upsert: true });
    } catch (error) {
      // Two upserts raced on the same id: the job is queued, which is all this promises
      if ((error as any)?.code !== 11000) throw error;
    }
  }

  async claim(workerId: string, leaseMs: number): Promise<Claim | null> {
    const now = new Date();
    const token = randomUUID();
    const job: any = await QueuedJobModel.findOneAndUpdate(
      { visibleAt: { $lte: now } },
      { $set: { visibleAt: new Date(now.getTime() + leaseMs), token, owner: workerId } },
      { sort: { visibleAt: 1 }, new: true, lean: true }
    );
    return job ? { job: { id: job._id, runId: job.runId }, token } : null;
  }

  async extend({ job, token }: Claim, leaseMs: number): Promise<boolean> {
    const result = await QueuedJobModel.updateOne({ _id: job.id, token }, { $set: { visibleAt: new Date(Date.now() + leaseMs) } });
    return result.matchedCount > 0;
  }

  async ack({ job, token }: Claim): Promise<void> {
    await QueuedJobModel.deleteOne({ _id: job.id, token });
  }

  async release({ job, token }: Claim, availableAt = new Date()): Promise<void> {
    await QueuedJobModel.updateOne({ _id: job.id, token }, { $set: { visibleAt: availableAt }, $unset: { token: 1, owner: 1 } });
  }

  async depth(): Promise<{ ready: number; delayed: number; leased: number }> {
    const now = new Date();
    const [ready, delayed, leased] = await Promise.all([
      // A lease that ran out counts as ready: anyone can claim that job now
      QueuedJobModel.countDocuments({ visibleAt: { $lte: now } }),
      QueuedJobModel.countDocuments({ visibleAt: { $gt: now }, token: null }),
      QueuedJobModel.countDocuments({ visibleAt: { $gt: now }, token: { $ne: null } }),
    ]);
    return { ready, delayed, leased };
  }
}
