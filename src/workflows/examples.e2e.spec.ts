import mongoose from 'mongoose';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../app.setup';
import { loadExample } from '../testing/examples';
import { closeApp, sendJson, startTestServer, TestServer } from '../testing/http-server';
import { startTestMongo } from '../testing/mongo';
import { WorkflowModule } from './workflow.module';

// The example workflows from the web UI, run end to end through the HTTP API
// against a fake GitHub and a throwaway MongoDB
describe('example workflows', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let github: TestServer;
  let stopMongo: () => Promise<void>;

  const repos = [
    { full_name: 'nestjs/nest', stargazers_count: 70000, language: 'TypeScript', id: 1 },
    { full_name: 'nestjs/docs', stargazers_count: 1500, language: null, id: 2 },
    { full_name: 'nestjs/tiny', stargazers_count: 10, language: 'Go', id: 3 },
  ];

  const run = async (definition: unknown, input: unknown) => {
    const response = await fetch(`${baseUrl}/workflow/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition, input }),
    });
    return { status: response.status, body: await response.json() };
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    ({ stop: stopMongo } = await startTestMongo());
    github = await startTestServer((req, res) => sendJson(res, 200, { total_count: repos.length, items: repos }));

    app = await NestFactory.create<NestExpressApplication>(WorkflowModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await closeApp(app);
    await github.close();
    await stopMongo();
    jest.restoreAllMocks();
  });

  it('popular-repos: searches, filters, reshapes and stores, using primitives only', async () => {
    const { workflow, input } = loadExample('popular-repos');

    const { status, body } = await run(workflow, { ...input, apiUrl: github.url });

    expect(status).toBe(201);
    expect(github.requests[0].url).toBe('/search/repositories?q=org:nestjs&sort=stars&order=desc&per_page=100');
    expect(body.steps.summary.output).toEqual([
      { name: 'nestjs/nest', stars: 70000, language: 'TypeScript' },
      { name: 'nestjs/docs', stars: 1500, language: null },
    ]);
    expect(body.steps.save.output).toEqual({ insertedCount: 1 });

    const [stored] = await mongoose.connection.db.collection('repos').find().toArray();
    expect(stored.org).toBe('nestjs');
    expect(stored.repos).toHaveLength(2);
    expect(stored.timestamp).toBeInstanceOf(Date);
  });

  it('popular-repos: the input schema rejects an org that could add search qualifiers', async () => {
    const { workflow } = loadExample('popular-repos');

    const { status, body } = await run(workflow, { org: 'nestjs stars:>1' });

    expect(status).toBe(400);
    expect(body.errors).toEqual(['input.org must match pattern "^[A-Za-z0-9-]+$"']);
  });

  it.each(['undeclared-dependency', 'bad-params', 'cycle-example'])('%s is rejected before anything runs', async name => {
    const { workflow, input } = loadExample(name);

    const { status, body } = await run(workflow, input);

    expect(status).toBe(400);
    expect(body.message).toBe('Invalid workflow definition');
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
