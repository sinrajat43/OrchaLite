import { Injectable } from '@nestjs/common';
import mongoose, { Schema } from 'mongoose';
import { ConnectionLookup, HttpConnection } from '../tasks/task.interface';
import { Sealed, SECRET_KEY_ENV, SecretBox } from './secret-box';

export interface ConnectionInput {
  type: 'http';
  baseUrl: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** What the API shows: names of secret values, never the values */
export interface ConnectionSummary {
  name: string;
  type: 'http';
  baseUrl: string;
  headerNames: string[];
  queryNames: string[];
  updatedAt: Date;
}

interface ConnectionDocument extends Omit<ConnectionSummary, 'updatedAt'> {
  secret: Sealed;
  createdAt: Date;
  updatedAt: Date;
}

export class ConnectionsDisabledError extends Error {
  constructor() {
    super(`Connections need an encryption key: set ${SECRET_KEY_ENV} (openssl rand -base64 32)`);
    this.name = 'ConnectionsDisabledError';
  }
}

export class UnknownConnectionError extends Error {
  constructor(name: string) {
    super(`Unknown connection "${name}"`);
    this.name = 'UnknownConnectionError';
  }
}

const ConnectionSchema = new Schema<ConnectionDocument>(
  {
    name: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    baseUrl: { type: String, required: true },
    headerNames: [String],
    queryNames: [String],
    secret: { keyId: String, iv: String, tag: String, data: String },
  },
  { timestamps: true }
);

const ConnectionModel =
  (mongoose.models.Connection as mongoose.Model<ConnectionDocument>) ??
  mongoose.model<ConnectionDocument>('Connection', ConnectionSchema, 'connections');

// The ciphertext is bound to its record, so it cannot be copied onto another connection
const contextFor = (name: string) => `connection:${name}`;

const summarize = (doc: ConnectionDocument): ConnectionSummary => ({
  name: doc.name,
  type: doc.type,
  baseUrl: doc.baseUrl,
  headerNames: doc.headerNames,
  queryNames: doc.queryNames,
  updatedAt: doc.updatedAt,
});

/**
 * Stores named credentials encrypted at rest and decrypts them for a step
 */
@Injectable()
export class ConnectionsService implements ConnectionLookup {
  private readonly box = SecretBox.fromEnv();

  private requireBox(): SecretBox {
    if (!this.box) throw new ConnectionsDisabledError();
    return this.box;
  }

  async put(name: string, input: ConnectionInput): Promise<ConnectionSummary> {
    const headers = input.headers ?? {};
    const query = input.query ?? {};
    const doc = await ConnectionModel.findOneAndUpdate(
      { name },
      {
        name,
        type: input.type,
        baseUrl: input.baseUrl,
        headerNames: Object.keys(headers),
        queryNames: Object.keys(query),
        secret: this.requireBox().seal({ headers, query }, contextFor(name)),
      },
      { upsert: true, new: true, lean: true }
    );
    return summarize(doc);
  }

  async list(): Promise<ConnectionSummary[]> {
    const docs = await ConnectionModel.find().sort({ name: 1 }).lean();
    return docs.map(summarize);
  }

  async delete(name: string): Promise<boolean> {
    const result = await ConnectionModel.deleteOne({ name });
    return result.deletedCount > 0;
  }

  async get(name: string): Promise<HttpConnection> {
    const box = this.requireBox();
    const doc = await ConnectionModel.findOne({ name }).lean();
    if (!doc) throw new UnknownConnectionError(name);
    const { headers, query } = box.open<{ headers: Record<string, string>; query: Record<string, string> }>(
      doc.secret,
      contextFor(name)
    );
    return { name, type: doc.type, baseUrl: doc.baseUrl, headers, query };
  }
}
