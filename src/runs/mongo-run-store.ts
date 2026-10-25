import { Schema, model, models, Model } from 'mongoose';
import { DuplicateEventError, RunStore } from './run-store';
import { RunEvent, RunQuery, RunSummary } from './run.types';

const RunEventSchema = new Schema(
  {
    runId: { type: String, required: true },
    seq: { type: Number, required: true },
    type: { type: String, required: true },
    at: { type: Date, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { versionKey: false, minimize: false }
);
// Orders the timeline and turns a duplicate append into an error instead of a doubled event
RunEventSchema.index({ runId: 1, seq: 1 }, { unique: true });

const StepSummarySchema = new Schema(
  {
    id: String,
    task: String,
    status: String,
    startedAt: Date,
    endedAt: Date,
    durationMs: Number,
    error: String,
  },
  { _id: false }
);

const RunSummarySchema = new Schema(
  {
    _id: { type: String },
    name: String,
    status: String,
    startedAt: Date,
    endedAt: Date,
    durationMs: Number,
    definition: Schema.Types.Mixed,
    failedStepId: String,
    error: String,
    steps: [StepSummarySchema],
    lastSeq: Number,
  },
  { versionKey: false }
);
// Run ids are ObjectId hex strings, so sorting by _id sorts by start time
RunSummarySchema.index({ status: 1, _id: -1 });
RunSummarySchema.index({ name: 1, _id: -1 });

const RunEventModel: Model<any> = models.RunEvent ?? model('RunEvent', RunEventSchema, 'run_events');
const RunSummaryModel: Model<any> = models.RunSummary ?? model('RunSummary', RunSummarySchema, 'workflow_runs');

const toEvent = ({ _id, ...event }: any): RunEvent => event;
const toSummary = ({ _id, ...run }: any): RunSummary => ({ id: _id, ...run });

/**
 * RunStore on the default mongoose connection: `run_events` holds the
 * timeline, `workflow_runs` one summary per run.
 */
export class MongoRunStore implements RunStore {
  async appendEvent(event: RunEvent): Promise<void> {
    try {
      await RunEventModel.create(event);
    } catch (error) {
      if ((error as any)?.code === 11000) throw new DuplicateEventError(event.runId, event.seq);
      throw error;
    }
  }

  async saveSummary({ id, ...summary }: RunSummary): Promise<void> {
    await RunSummaryModel.replaceOne({ _id: id }, summary, { upsert: true });
  }

  async listRuns({ status, name, limit, before }: RunQuery): Promise<RunSummary[]> {
    const filter: Record<string, any> = {};
    if (status) filter.status = status;
    if (name) filter.name = name;
    if (before) filter._id = { $lt: before };
    // The definition snapshot can be large and the list does not need it
    const runs = await RunSummaryModel.find(filter, { definition: 0 }).sort({ _id: -1 }).limit(limit).lean();
    return runs.map(toSummary);
  }

  async getRun(runId: string): Promise<RunSummary | null> {
    const run = await RunSummaryModel.findById(runId).lean();
    return run ? toSummary(run) : null;
  }

  async getEvents(runId: string): Promise<RunEvent[]> {
    const events = await RunEventModel.find({ runId }).sort({ seq: 1 }).lean();
    return events.map(toEvent);
  }

  async findRunning(): Promise<RunSummary[]> {
    const runs = await RunSummaryModel.find({ status: 'RUNNING' }).lean();
    return runs.map(toSummary);
  }
}
