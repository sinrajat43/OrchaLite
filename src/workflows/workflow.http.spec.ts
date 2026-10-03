import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../app.setup';
import { WorkflowModule } from './workflow.module';

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

    // WorkflowModule alone, so no MongoDB connection is needed
    app = await NestFactory.create<NestExpressApplication>(WorkflowModule, { logger: false });
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
    });
  });
});
