import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Type } from '@sinclair/typebox';
import { configureApp } from '../app.setup';
import { closeApp } from '../testing/http-server';
import { Task, TaskContext } from '../tasks/task.interface';
import { TaskHandler } from '../tasks/task-handler.decorator';
import { WorkflowModule } from './workflow.module';

abstract class TestTask implements Task {
  readonly paramsSchema = Type.Any();
  readonly outputSchema = Type.Any();
  abstract execute(ctx: TaskContext): Promise<unknown>;
}

@TaskHandler({ name: 'one', version: 1 })
class OneTask extends TestTask {
  async execute() {
    return 1;
  }
}

@TaskHandler({ name: 'double', version: 1 })
class DoubleTask extends TestTask {
  async execute({ params }: TaskContext<{ n: number }>) {
    return params.n * 2;
  }
}

@TaskHandler({ name: 'nothing', version: 1 })
class NothingTask extends TestTask {
  async execute() {
    return undefined;
  }
}

@TaskHandler({ name: 'boom', version: 1 })
class BoomTask extends TestTask {
  async execute(): Promise<never> {
    throw new Error('kaput');
  }
}

// Tasks registered outside the engine's modules, the way any new task would be.
// WorkflowModule alone, plus these, so no MongoDB connection is needed.
@Module({
  imports: [WorkflowModule],
  providers: [OneTask, DoubleTask, NothingTask, BoomTask],
})
class TestAppModule {}

describe('HTTP API', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  const post = (definition: unknown, input?: unknown) =>
    fetch(`${baseUrl}/workflow/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition, input }),
    });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    app = await NestFactory.create<NestExpressApplication>(TestAppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await closeApp(app);
    jest.restoreAllMocks();
  });

  it('serves the web UI at /', async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>OrchaLite</title>');
  });

  it('lists the task catalogue, including tasks discovered in other modules, with schemas', async () => {
    const response = await fetch(`${baseUrl}/tasks`);

    expect(response.status).toBe(200);
    const tasks = await response.json();
    expect(tasks.map((t: { name: string }) => t.name)).toEqual([
      'boom', 'delay', 'double', 'filter', 'http.request', 'mongo.insert', 'nothing', 'notify.webhook', 'one', 'transform',
    ]);
    const http = tasks.find((t: { name: string }) => t.name === 'http.request');
    expect(http).toMatchObject({ version: 1, description: expect.any(String) });
    expect(http.paramsSchema).toMatchObject({ type: 'object', required: ['url'], additionalProperties: false });
    expect(http.outputSchema.properties).toHaveProperty('status');
  });

  it('runs a workflow with input and returns every step result', async () => {
    const response = await post(
      {
        name: 'ok',
        input: { times: 'integer' },
        steps: [
          { id: 'a', task: 'one', dependsOn: [] },
          { id: 'b', task: 'double', params: { n: '{{ steps.a.output * input.times }}' }, dependsOn: ['a'] },
          { id: 'c', task: 'nothing', dependsOn: ['b'] },
        ],
      },
      { times: 5 }
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.runId).toEqual(expect.any(String));
    expect(body.steps).toEqual({
      a: { status: 'succeeded', output: 1 },
      b: { status: 'succeeded', output: 10 },
      c: { status: 'succeeded' },
    });
  });

  it('rejects run input that does not match the declared input', async () => {
    const response = await post(
      { name: 'bad', input: { times: 'integer' }, steps: [{ id: 'a', task: 'one', dependsOn: [] }] },
      { times: 'many' }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'Invalid run input', errors: ['input.times must be integer'] });
  });

  it('rejects an expression that reads a step it does not depend on', async () => {
    const response = await post({
      name: 'bad',
      steps: [
        { id: 'a', task: 'one', dependsOn: [] },
        { id: 'b', task: 'double', params: { n: '{{ steps.a.output }}' }, dependsOn: [] },
      ],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Invalid workflow definition',
      errors: ['Step "b" params.n references step "a", which it does not depend on'],
    });
  });

  it('rejects a body that fails DTO validation', async () => {
    const response = await post({ name: 'bad', steps: [{ id: 'a', dependsOn: [] }] });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('definition.steps.0.task must be a string');
  });

  it('rejects unknown properties', async () => {
    const response = await post({ name: 'bad', extra: true, steps: [{ id: 'a', task: 'one', dependsOn: [] }] });

    expect(response.status).toBe(400);
  });

  it('requires a definition', async () => {
    const response = await fetch(`${baseUrl}/workflow/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });


    expect(response.status).toBe(400);
  });

  it('rejects tasks that are not registered', async () => {
    const response = await post({ name: 'bad', steps: [{ id: 'a', task: 'nope', dependsOn: [] }] });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Invalid workflow definition',
      errors: ['Step "a" uses unknown task "nope"'],
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
