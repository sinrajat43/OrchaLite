import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../app.setup';
import { Module } from '@nestjs/common';
import { WorkflowModule } from './workflow.module';
import { RunsModule } from '../runs/runs.module';
import { InMemoryRunStore } from '../runs/in-memory-run-store';

jest.mock('../tasks/task-registry', () => ({
  taskRegistry: {
    one: { execute: async () => 1 },
    double: { execute: async (input: number) => input * 2 },
    nothing: { execute: async () => undefined },
    boom: {
      execute: async () => {
        throw new Error('kaput');
      },
    },
  },
}));

describe('HTTP API', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  const post = (body: unknown) =>
    fetch(`${baseUrl}/workflow/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    // Run history in memory, so no MongoDB connection is needed
    @Module({ imports: [RunsModule.forRoot(new InMemoryRunStore()), WorkflowModule] })
    class TestAppModule {}
    app = await NestFactory.create<NestExpressApplication>(TestAppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('serves the web UI at /', async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>OrchaLite</title>');
  });

  it('lists the registered tasks', async () => {
    const response = await fetch(`${baseUrl}/workflow/tasks`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(['one', 'double', 'nothing', 'boom']);
  });

  it('runs a workflow and returns every step result', async () => {
    const response = await post({
      name: 'ok',
      steps: [
        { id: 'a', task: 'one', dependsOn: [] },
        { id: 'b', task: 'double', dependsOn: ['a'] },
        { id: 'c', task: 'nothing', dependsOn: ['b'] },
      ],
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ a: 1, b: 2 });
  });

  it('rejects a body that fails DTO validation', async () => {
    const response = await post({ name: 'bad', steps: [{ id: 'a', dependsOn: [] }] });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('steps.0.task must be a string');
  });

  it('rejects unknown properties', async () => {
    const response = await post({ name: 'bad', extra: true, steps: [{ id: 'a', task: 'one', dependsOn: [] }] });

    expect(response.status).toBe(400);
  });

  it('rejects tasks that are not registered', async () => {
    const response = await post({ name: 'bad', steps: [{ id: 'a', task: 'nope', dependsOn: [] }] });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Invalid tasks in workflow',
      missingTasks: ['nope'],
    });
  });

  it('rejects a workflow that is not a valid DAG', async () => {
    const response = await post({
      name: 'cycle',
      steps: [
        { id: 'a', task: 'one', dependsOn: ['b'] },
        { id: 'b', task: 'one', dependsOn: ['a'] },
      ],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Invalid workflow definition',
      errors: ['Circular dependency involving steps: a, b'],
    });
  });

  it('reports which step failed and why', async () => {
    const response = await post({
      name: 'fails',
      steps: [
        { id: 'a', task: 'one', dependsOn: [] },
        { id: 'b', task: 'boom', dependsOn: ['a'] },
      ],
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      message: 'Task execution failed: kaput',
      stepId: 'b',
      task: 'boom',
      runId: response.headers.get('x-run-id'),
    });
  });

  describe('run history', () => {
    const getJson = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`);
      return { status: response.status, body: await response.json() };
    };

    it('records a successful run with each step', async () => {
      const response = await post({
        name: 'history-ok',
        steps: [
          { id: 'a', task: 'one', dependsOn: [] },
          { id: 'b', task: 'double', dependsOn: ['a'] },
        ],
      });
      const runId = response.headers.get('x-run-id');
      expect(runId).toMatch(/^[0-9a-f]{24}$/);

      const run = await getJson(`/runs/${runId}`);
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({
        id: runId,
        name: 'history-ok',
        status: 'SUCCEEDED',
        steps: [
          { id: 'a', task: 'one', status: 'SUCCEEDED' },
          { id: 'b', task: 'double', status: 'SUCCEEDED' },
        ],
      });
      expect(Date.parse(run.body.steps[0].startedAt)).not.toBeNaN();

      const events = await getJson(`/runs/${runId}/events`);
      expect(events.body.map((e: any) => e.type)).toEqual([
        'RunStarted', 'StepStarted', 'StepSucceeded', 'StepStarted', 'StepSucceeded', 'RunSucceeded',
      ]);
      expect(events.body[4].data).toEqual({ stepId: 'b', output: 2 });
    });

    it('records a failed run with the failed and skipped steps', async () => {
      const response = await post({
        name: 'history-fails',
        steps: [
          { id: 'a', task: 'boom', dependsOn: [] },
          { id: 'b', task: 'one', dependsOn: ['a'] },
        ],
      });
      const run = await getJson(`/runs/${response.headers.get('x-run-id')}`);
      expect(run.body).toMatchObject({
        status: 'FAILED',
        failedStepId: 'a',
        error: 'Task execution failed: kaput',
        steps: [
          { id: 'a', status: 'FAILED' },
          { id: 'b', status: 'SKIPPED' },
        ],
      });
    });

    it('does not record rejected definitions', async () => {
      const response = await post({ name: 'history-rejected', steps: [{ id: 'a', task: 'one', dependsOn: ['a'] }] });
      expect(response.status).toBe(400);
      expect(response.headers.get('x-run-id')).toBeNull();
      expect((await getJson('/runs?name=history-rejected')).body).toEqual([]);
    });

    it('lists runs newest first and filters them', async () => {
      const all = await getJson('/runs');
      expect(all.status).toBe(200);
      const ids = all.body.map((r: any) => r.id);
      expect(ids).toEqual([...ids].sort().reverse());

      const failed = await getJson('/runs?status=FAILED');
      expect(failed.body.length).toBeGreaterThan(0);
      expect(failed.body.every((r: any) => r.status === 'FAILED')).toBe(true);

      const page = await getJson(`/runs?limit=1&before=${ids[0]}`);
      expect(page.body.map((r: any) => r.id)).toEqual([ids[1]]);
    });

    it('rejects bad list queries and unknown runs', async () => {
      expect((await getJson('/runs?status=NOPE')).status).toBe(400);
      expect((await getJson('/runs?limit=0')).status).toBe(400);
      expect((await getJson('/runs?before=xyz')).status).toBe(400);
      expect((await getJson('/runs/0123456789abcdef01234567')).status).toBe(404);
      expect((await getJson('/runs/0123456789abcdef01234567/events')).status).toBe(404);
    });
  });
});
