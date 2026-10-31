import { BullMqStepQueue } from './bullmq-step-queue';
import { MongoStepQueue } from './mongo-step-queue';
import { StepQueue } from './step-queue';

const positive = (value: string | undefined, fallback: number): number => (Number(value) > 0 ? Number(value) : fallback);

/** The queue this deployment uses: ORCHALITE_QUEUE=mongo (the default) or bullmq */
export function stepQueueFromEnv(env: NodeJS.ProcessEnv = process.env): StepQueue {
  switch (env.ORCHALITE_QUEUE ?? 'mongo') {
    case 'mongo':
      return new MongoStepQueue();
    case 'bullmq':
      return new BullMqStepQueue(env.REDIS_URL ?? 'redis://127.0.0.1:6379', positive(env.ORCHALITE_STALLED_INTERVAL_MS, 5000));
    default:
      throw new Error(`ORCHALITE_QUEUE: unknown queue "${env.ORCHALITE_QUEUE}"; use mongo or bullmq`);
  }
}
