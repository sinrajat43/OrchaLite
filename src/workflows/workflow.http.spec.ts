import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Type } from '@sinclair/typebox';
import { configureApp } from '../app.setup';
import { closeApp } from '../testing/http-server';
import { Task, TaskContext } from '../tasks/task.interface';
import { TaskHandler } from '../tasks/task-handler.decorator';
import { WorkflowModule } from './workflow.module';
import { RunsModule } from '../runs/runs.module';
import { InMemoryRunStore } from '../runs/in-memory-run-store';

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

@TaskHandler({ name: 'slow', version: 1 })
class SlowTask extends TestTask {
  static gate: Promise<string>;
  async execute() {
    return SlowTask.gate;
  }
}

// Tasks registered outside the engine's modules, the way any new task would be.
// WorkflowModule alone, plus these, with run history in memory, so no MongoDB connection is needed.
@Module({
  imports: [RunsModule.inMemory(new InMemoryRunStore()), WorkflowModule],
  providers: [OneTask, DoubleTask, NothingTask, BoomTask, SlowTask],
})
class TestAppModule {}

describe('HTTP API', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  const post = (definition: unknown, input?: unknown) =>
    fetch(`${baseUrl}/workflow/run?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition, input }),
    });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

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
      'boom', 'delay', 'double', 'filter', 'http.request', 'mongo.findOne', 'mongo.insert', 'mongo.upsert', 'nothing',
      'notify.webhook', 'one', 'slow', 'transform',
    ]);
    const http = tasks.find((t: { name: string }) => t.name === 'http.request');
    expect(http).toMatchObject({ version: 1, description: expect.any(String) });
    expect(http.paramsSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(http.paramsSchema.properties)).toEqual(expect.arrayContaining(['url', 'connection', 'method']));
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

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runId).toEqual(expect.any(String));
    expect(body.steps).toEqual({
      a: { status: 'succeeded', output: 1 },
      b: { status: 'succeeded', output: 10 },
      c: { status: 'succeeded' },
    });
  });

  it('accepts a run with 202 and a run id before its steps finish, and the result can be polled', async () => {
    let finish: (value: string) => void;
    SlowTask.gate = new Promise(resolve => (finish = resolve));

    const response = await fetch(`${baseUrl}/workflow/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'async', steps: [{ id: 'slow', task: 'slow', dependsOn: [] }] } }),
    });

    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(accepted).toEqual({ runId: expect.stringMatching(/^[0-9a-f]{24}$/), status: 'RUNNING' });

    const during = await (await fetch(`${baseUrl}/runs/${accepted.runId}/result`)).json();
    expect(during.status).toBe('RUNNING');

    finish('done');
    let result = during;
    for (let i = 0; i < 200 && result.status === 'RUNNING'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      result = await (await fetch(`${baseUrl}/runs/${accepted.runId}/result`)).json();
    }
    expect(result).toEqual({ runId: accepted.runId, status: 'SUCCEEDED', steps: { slow: { status: 'succeeded', output: 'done' } } });
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
      runId: expect.stringMatching(/^[0-9a-f]{24}$/),
    });
  });

  describe('run history', () => {
    const getJson = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`);
      return { status: response.status, body: await response.json() };
    };

    it('records a successful run with its input and each step', async () => {
      const response = await post(
        {
          name: 'history-ok',
          input: { times: { type: 'integer', default: 2 } },
          steps: [
            { id: 'a', task: 'one', dependsOn: [] },
            { id: 'b', task: 'double', params: { n: '{{ steps.a.output * input.times }}' }, dependsOn: ['a'] },
            { id: 'off', task: 'one', when: '{{ false }}', dependsOn: ['a'] },
          ],
        },
        {}
      );
      const { runId } = await response.json();
      expect(runId).toMatch(/^[0-9a-f]{24}$/);

      const run = await getJson(`/runs/${runId}`);
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({
        id: runId,
        name: 'history-ok',
        status: 'SUCCEEDED',
        input: { times: 2 },
        steps: [
          { id: 'a', task: 'one', status: 'SUCCEEDED' },
          { id: 'b', task: 'double', status: 'SUCCEEDED' },
          { id: 'off', task: 'one', status: 'SKIPPED', reason: 'when was false' },
        ],
      });
      expect(run.body.workflow).toBeUndefined();
      expect(Date.parse(run.body.steps[0].startedAt)).not.toBeNaN();

      const events = await getJson(`/runs/${runId}/events`);
      const timeline = events.body.map((e: any) => [e.type, e.data.stepId].filter(Boolean).join(' '));
      expect(timeline.slice(0, 3)).toEqual(['RunStarted', 'StepStarted a', 'StepSucceeded a']);
      expect(timeline.slice(3, 7).sort()).toEqual(['StepSkipped off', 'StepStarted b', 'StepStarted off', 'StepSucceeded b']);
      expect(timeline.indexOf('StepStarted b')).toBeLessThan(timeline.indexOf('StepSucceeded b'));
      expect(timeline[7]).toBe('RunSucceeded');
      expect(events.body.find((e: any) => e.type === 'StepSucceeded' && e.data.stepId === 'b').data).toEqual({ stepId: 'b', output: 4 });
    });

    it('records a failed run with the failed and skipped steps', async () => {
      const response = await post({
        name: 'history-fails',
        steps: [
          { id: 'a', task: 'boom', dependsOn: [] },
          { id: 'b', task: 'one', dependsOn: ['a'] },
        ],
      });
      const { runId } = await response.json();
      const run = await getJson(`/runs/${runId}`);
      expect(run.body).toMatchObject({
        status: 'FAILED',
        failedStepId: 'a',
        error: 'Task execution failed: kaput',
        steps: [
          { id: 'a', status: 'FAILED' },
          { id: 'b', status: 'SKIPPED', reason: 'an earlier step failed' },
        ],
      });
    });

    it('does not record rejected definitions or input', async () => {
      const cycle = await post({ name: 'history-rejected', steps: [{ id: 'a', task: 'one', dependsOn: ['a'] }] });
      expect(cycle.status).toBe(400);
      const input = await post({ name: 'history-rejected', input: { n: 'integer' }, steps: [{ id: 'a', task: 'one', dependsOn: [] }] }, { n: 'x' });
      expect(input.status).toBe(400);
      expect((await getJson('/runs?name=history-rejected')).body).toEqual([]);
    });

    it('lists runs newest first and filters them', async () => {
      const all = await getJson('/runs');
      expect(all.status).toBe(200);
      const ids = all.body.map((r: any) => r.id);
      expect(ids.length).toBeGreaterThan(2);
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
