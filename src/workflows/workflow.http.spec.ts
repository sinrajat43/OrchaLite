import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Type } from '@sinclair/typebox';
import { configureApp } from '../app.setup';
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
  async execute({ input }: TaskContext<unknown, number>) {
    return input * 2;
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

  const post = (body: unknown) =>
    fetch(`${baseUrl}/workflow/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    await app.close();
    jest.restoreAllMocks();
  });

  it('serves the web UI at /', async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>OrchaLite</title>');
  });

  it('lists the built-in tasks and tasks discovered in other modules', async () => {
    const response = await fetch(`${baseUrl}/workflow/tasks`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.arrayContaining(['fetchRepos', 'filterRepos', 'storeRepos', 'one', 'double', 'nothing', 'boom'])
    );
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
