import { Schema, model, models, Model } from 'mongoose';
import { StepRun, StepRunExpectation, StepRunUpdateOptions } from '../engine/step-run';
import { DuplicateEventError, RunRequest, RunStore } from './run-store';
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
    reason: String,
    iterations: Number,
    retries: Number,
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
    input: Schema.Types.Mixed,
    workflow: { name: String, version: Number },
    execution: String,
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

const StepRunSchema = new Schema(
  {
    _id: { type: String },
    runId: { type: String, required: true },
    stepId: String,
    task: String,
    index: Number,
    item: Schema.Types.Mixed,
    fanOut: Boolean,
    status: String,
    version: Number,
    fence: Number,
    output: Schema.Types.Mixed,
    error: String,
    reason: String,
    iterations: Number,
    notBefore: Date,
    resumed: Boolean,
    failures: [{ _id: false, attempt: Number, error: String, at: Date }],
    startedAt: Date,
    endedAt: Date,
  },
  // Outputs are stored as tasks returned them, even when empty
  { versionKey: false, minimize: false }
);
StepRunSchema.index({ runId: 1, stepId: 1, index: 1 });
StepRunSchema.index({ status: 1, _id: -1 });

// A key claims a run id once, through the unique _id; there is no expiry yet
const RunRequestSchema = new Schema(
  { _id: { type: String }, fingerprint: String, runId: String, at: Date },
  { versionKey: false }
);

const RunEventModel: Model<any> = models.RunEvent ?? model('RunEvent', RunEventSchema, 'run_events');
const RunSummaryModel: Model<any> = models.RunSummary ?? model('RunSummary', RunSummarySchema, 'workflow_runs');

const StepRunModel: Model<any> = models.StepRun ?? model('StepRun', StepRunSchema, 'step_runs');

const RunRequestModel: Model<any> = models.RunRequest ?? model('RunRequest', RunRequestSchema, 'run_requests');

const toRow = ({ _id, ...row }: any): StepRun => ({ id: _id, ...row });
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

  async saveSummary({ id, ...summary }: RunSummary, expectedLastSeq: number): Promise<boolean> {
    try {
      // A failed version check matches nothing, then the upsert hits the _id index
      const result = await RunSummaryModel.replaceOne({ _id: id, lastSeq: expectedLastSeq }, summary, { upsert: expectedLastSeq === 0 });
      return result.matchedCount + result.upsertedCount > 0;
    } catch (error) {
      if ((error as any)?.code === 11000) return false;
      throw error;
    }
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

  async getEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    const events = await RunEventModel.find({ runId, seq: { $gt: afterSeq } }).sort({ seq: 1 }).lean();
    return events.map(toEvent);
  }

  async findRunning(): Promise<RunSummary[]> {
    const runs = await RunSummaryModel.find({ status: 'RUNNING' }).lean();
    return runs.map(toSummary);
  }

  async insertStepRuns(rows: StepRun[]): Promise<void> {
    if (!rows.length) return;
    try {
      await StepRunModel.insertMany(rows.map(({ id, ...row }) => ({ _id: id, ...row })), { ordered: false });
    } catch (error) {
      // Rows another scheduler pass already created stay as they are
      if ((error as any)?.code !== 11000) throw error;
    }
  }

  async getStepRun(id: string): Promise<StepRun | null> {
    const row: any = await StepRunModel.findById(id).lean();
    return row ? toRow(row) : null;
  }

  async listStepRuns(runId: string): Promise<StepRun[]> {
    const rows = await StepRunModel.find({ runId }, { output: 0, item: 0 }).lean();
    return rows.map(toRow);
  }

  async getStepOutputs(runId: string, stepIds?: string[]): Promise<Record<string, unknown>> {
    const filter: Record<string, any> = { runId, index: null };
    if (stepIds) filter.stepId = { $in: stepIds };
    const rows = await StepRunModel.find(filter, { stepId: 1, output: 1 }).lean<any[]>();
    return Object.fromEntries(rows.map(row => [row.stepId, row.output]));
  }

  async getItemOutputs(runId: string, stepId: string): Promise<unknown[]> {
    const rows = await StepRunModel.find({ runId, stepId, index: { $ne: null } }, { output: 1 }).sort({ index: 1 }).lean<any[]>();
    return rows.map(row => row.output);
  }

  async updateStepRun(id: string, expected: StepRunExpectation, changes: Partial<StepRun>, options: StepRunUpdateOptions = {}): Promise<StepRun | null> {
    const filter: Record<string, any> = { _id: id };
    if (expected.status) filter.status = { $in: expected.status };
    if (expected.fence !== undefined) filter.fence = expected.fence;
    const inc = { version: 1, ...(options.takeFence ? { fence: 1 } : {}) };
    const row: any = await StepRunModel.findOneAndUpdate(filter, { $set: changes, $inc: inc }, { new: true, lean: true });
    return row ? toRow(row) : null;
  }

  async listDeadLetters(limit: number): Promise<StepRun[]> {
    const rows = await StepRunModel.find({ status: 'DEAD_LETTERED' }, { output: 0 }).sort({ _id: -1 }).limit(limit).lean();
    return rows.map(toRow);
  }

  async claimRunRequest(request: RunRequest): Promise<RunRequest> {
    try {
      await RunRequestModel.create({ _id: request.key, fingerprint: request.fingerprint, runId: request.runId, at: new Date() });
      return request;
    } catch (error) {
      if ((error as any)?.code !== 11000) throw error;
      const { _id, fingerprint, runId }: any = await RunRequestModel.findById(request.key).lean();
      return { key: _id, fingerprint, runId };
    }
  }
}
