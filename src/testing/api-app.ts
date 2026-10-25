import { randomBytes } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ApiModule } from '../api.module';
import { configureApp } from '../app.setup';
import { SECRET_KEY_ENV } from '../connections/secret-box';
import { closeApp } from './http-server';
import { startTestMongo } from './mongo';

export interface TestApi {
  url: string;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

/**
 * The full HTTP API on a free port, backed by a throwaway MongoDB, with a
 * fresh encryption key for connections
 */
export async function startTestApi(): Promise<TestApi> {
  process.env[SECRET_KEY_ENV] = randomBytes(32).toString('base64');
  const mongo = await startTestMongo();

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
  configureApp(app);
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  return {
    url,
    request: async (method, path, body) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    },
    close: async () => {
      await closeApp(app);
      await mongo.stop();
      delete process.env[SECRET_KEY_ENV];
    },
  };
}
