import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import mongoose, { Schema } from 'mongoose';
import { WorkflowDefinition } from '../orchestrator/workflow-definition';

export interface StoredDefinition {
  name: string;
  version: number;
  definition: WorkflowDefinition;
  createdAt: Date;
}

export interface DefinitionSummary {
  name: string;
  latestVersion: number;
  versions: number;
  updatedAt: Date;
}

interface DefinitionDocument {
  name: string;
  version: number;
  /** The definition as JSON text: stored exactly as submitted, never edited */
  source: string;
  /** Hash of the canonical JSON, to spot a resubmission of the latest version */
  hash: string;
  createdAt: Date;
}

const DefinitionSchema = new Schema<DefinitionDocument>(
  {
    name: { type: String, required: true },
    version: { type: Number, required: true },
    source: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
// The unique index is what makes concurrent saves safe: only one can claim a version
DefinitionSchema.index({ name: 1, version: 1 }, { unique: true });

const DefinitionModel =
  (mongoose.models.WorkflowDefinition as mongoose.Model<DefinitionDocument>) ??
  mongoose.model<DefinitionDocument>('WorkflowDefinition', DefinitionSchema, 'workflow_definitions');

const MAX_SAVE_ATTEMPTS = 10;

/** JSON with object keys sorted, so equal definitions hash equally */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const toStored = (doc: DefinitionDocument): StoredDefinition => ({
  name: doc.name,
  version: doc.version,
  definition: JSON.parse(doc.source),
  createdAt: doc.createdAt,
});

/**
 * Versioned, immutable workflow definitions in MongoDB
 */
@Injectable()
export class DefinitionStore {
  private indexes?: Promise<unknown>;

  // Created on first use, after the app has connected
  private ready() {
    this.indexes ??= DefinitionModel.createIndexes();
    return this.indexes;
  }

  /**
   * Saves a definition as the next version of its name. Resubmitting the
   * latest version unchanged returns it instead of creating a new one.
   */
  async save(definition: WorkflowDefinition): Promise<{ name: string; version: number; created: boolean }> {
    await this.ready();
    const source = JSON.stringify(definition);
    const hash = createHash('sha256').update(canonical(definition)).digest('hex');
    const { name } = definition;

    // Optimistic concurrency: read the latest version, try to claim the next,
    // and if another save claimed it first, read again
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      const latest = await DefinitionModel.findOne({ name }).sort({ version: -1 }).lean();
      if (latest?.hash === hash) return { name, version: latest.version, created: false };

      const version = (latest?.version ?? 0) + 1;
      try {
        await DefinitionModel.create({ name, version, source, hash });
        return { name, version, created: true };
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
    }
    throw new Error(`Could not save "${name}": ${MAX_SAVE_ATTEMPTS} concurrent saves got there first`);
  }

  /** The given version, or the latest when version is omitted */
  async get(name: string, version?: number): Promise<StoredDefinition | undefined> {
    const query = version === undefined ? { name } : { name, version };
    const doc = await DefinitionModel.findOne(query).sort({ version: -1 }).lean();
    return doc ? toStored(doc) : undefined;
  }

  async versions(name: string): Promise<{ version: number; createdAt: Date }[]> {
    return DefinitionModel.find({ name }, { _id: 0, version: 1, createdAt: 1 }).sort({ version: -1 }).lean();
  }

  async list(): Promise<DefinitionSummary[]> {
    return DefinitionModel.aggregate<DefinitionSummary>([
      { $sort: { version: -1 } },
      { $group: { _id: '$name', latestVersion: { $first: '$version' }, versions: { $sum: 1 }, updatedAt: { $first: '$createdAt' } } },
      { $project: { _id: 0, name: '$_id', latestVersion: 1, versions: 1, updatedAt: 1 } },
      { $sort: { name: 1 } },
    ]);
  }
}
