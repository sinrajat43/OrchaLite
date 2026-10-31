import { Injectable } from '@nestjs/common';
import mongoose, { Schema } from 'mongoose';
import { Sealed } from '../connections/secret-box';

export interface Trigger {
  name: string;
  type: 'cron' | 'webhook';
  workflow: string;
  /** Pins a stored version; the latest by default */
  version?: number;
  /** cron: the run's input. webhook: a template over the delivery's body */
  input?: Record<string, unknown>;
  cron?: string;
  nextRunAt?: Date;
  /** webhook: the signing secret, encrypted */
  secret?: Sealed;
  enabled: boolean;
  lastRunId?: string;
  lastFiredAt?: Date;
  lastError?: string;
}

const TriggerSchema = new Schema(
  {
    _id: { type: String },
    type: String,
    workflow: String,
    version: Number,
    input: Schema.Types.Mixed,
    cron: String,
    nextRunAt: Date,
    secret: { _id: false, type: { keyId: String, iv: String, tag: String, data: String } },
    enabled: Boolean,
    lastRunId: String,
    lastFiredAt: Date,
    lastError: String,
  },
  { versionKey: false, minimize: false }
);
TriggerSchema.index({ type: 1, enabled: 1, nextRunAt: 1 });

const TriggerModel: mongoose.Model<any> = mongoose.models.Trigger ?? mongoose.model('Trigger', TriggerSchema, 'triggers');

const toTrigger = ({ _id, ...trigger }: any): Trigger => ({ name: _id, ...trigger });

@Injectable()
export class TriggerStore {
  async put({ name, ...trigger }: Trigger): Promise<Trigger> {
    await TriggerModel.replaceOne({ _id: name }, trigger, { upsert: true });
    return this.get(name);
  }

  async get(name: string): Promise<Trigger | null> {
    const trigger: any = await TriggerModel.findById(name).lean();
    return trigger ? toTrigger(trigger) : null;
  }

  async list(): Promise<Trigger[]> {
    const triggers = await TriggerModel.find().sort({ _id: 1 }).lean();
    return triggers.map(toTrigger);
  }

  async delete(name: string): Promise<boolean> {
    return (await TriggerModel.deleteOne({ _id: name })).deletedCount > 0;
  }

  async listDue(now: Date): Promise<Trigger[]> {
    const triggers = await TriggerModel.find({ type: 'cron', enabled: true, nextRunAt: { $lte: now } }).lean();
    return triggers.map(toTrigger);
  }

  /** Moves a cron trigger on, if nobody has since it was read */
  async advance(name: string, firedFor: Date, changes: Partial<Trigger>): Promise<boolean> {
    const result = await TriggerModel.updateOne({ _id: name, nextRunAt: firedFor }, { $set: changes });
    return result.modifiedCount > 0;
  }

  async record(name: string, changes: Partial<Trigger>): Promise<void> {
    await TriggerModel.updateOne({ _id: name }, { $set: changes });
  }
}
