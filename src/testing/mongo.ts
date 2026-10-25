import { execSync } from 'child_process';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server-core';

/**
 * Starts a throwaway MongoDB and connects the default mongoose connection to
 * it. Uses the mongod on the PATH when there is one, so no binary download.
 */
export async function startTestMongo(): Promise<{ uri: string; stop: () => Promise<void> }> {
  if (!process.env.MONGOMS_SYSTEM_BINARY) {
    try {
      const binary = execSync('command -v mongod', { encoding: 'utf8' }).trim();
      const version = execSync(`${binary} --version`, { encoding: 'utf8' }).match(/v(\d+\.\d+\.\d+)/)?.[1];
      process.env.MONGOMS_SYSTEM_BINARY = binary;
      if (version) process.env.MONGOMS_VERSION = version;
    } catch {
      // No local mongod: mongodb-memory-server downloads one
    }
  }

  const server = await MongoMemoryServer.create();
  const uri = server.getUri();
  await mongoose.connect(uri, { dbName: 'orchalite-test' });

  return {
    uri,
    stop: async () => {
      await mongoose.disconnect();
      await server.stop();
    },
  };
}
