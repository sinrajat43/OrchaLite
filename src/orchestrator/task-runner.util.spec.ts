import { runWorkflow, RunInputError } from './task-runner.util';
import { validateWorkflow, WorkflowDefinition, WorkflowDefinitionError, WorkflowStep } from './workflow-definition';
import { Task, TaskContext, TaskExecutionError } from '../tasks/task.interface';
import { Type } from '@sinclair/typebox';
import { fakeTask, silentLogger } from '../testing/task-context';

// A task with a real schema, to check validation of params
const typed: Task = {
  paramsSchema: Type.Object(
    { url: Type.String({ pattern: '^https?://' }), retries: Type.Optional(Type.Integer({ maximum: 5, default: 1 })) },
    { additionalProperties: false }
  ),
  outputSchema: Type.Any(),
  validate: params => (params.url === 'http://forbidden' ? ['params.url is forbidden'] : []),
  execute: async ({ params }) => params,
};

const lookup = (tasks: Record<string, Task>) => new Map(Object.entries(tasks));
const quiet = { createLogger: () => silentLogger };

const step = (id: string, task: string, dependsOn: string[] = [], params?: any): WorkflowStep => ({
  id,
  task,
  params,
  dependsOn,
});

const workflow = (steps: WorkflowStep[], input?: WorkflowDefinition['input']): WorkflowDefinition => ({
  name: 'test',
  input,
  steps,
});

// Returns its params, so a test can see exactly what a step received
const echo = fakeTask(async ({ params }) => params);
const anyTasks = lookup({ t: echo });

const issuesOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowDefinitionError);
    return (error as WorkflowDefinitionError).issues;
  }
  throw new Error('Expected WorkflowDefinitionError');
};

const outputs = (results: { steps: Record<string, { output?: unknown }> }) =>
  Object.fromEntries(Object.entries(results.steps).map(([id, result]) => [id, result.output]));

describe('validateWorkflow', () => {
  const validate = (steps: WorkflowStep[], input?: WorkflowDefinition['input']) =>
    validateWorkflow(workflow(steps, input), anyTasks);

  it('accepts a valid DAG regardless of declaration order', () => {
    expect(() => validate([step('c', 't', ['a', 'b']), step('b', 't', ['a']), step('a', 't')])).not.toThrow();
  });

  it('rejects duplicate step ids', () => {
    expect(issuesOf(() => validate([step('a', 't'), step('a', 't')]))).toEqual(['Duplicate step id "a"']);
  });

  it('rejects dependencies on unknown steps', () => {
    expect(issuesOf(() => validate([step('a', 't', ['missing'])]))).toEqual([
      'Step "a" depends on unknown step "missing"',
    ]);
  });

  it('rejects cycles and names only the steps involved', () => {
    const issues = issuesOf(() => validate([step('a', 't', ['b']), step('b', 't', ['a']), step('c', 't')]));
    expect(issues).toEqual(['Circular dependency involving steps: a, b']);
  });

  it('rejects a step that depends on itself', () => {
    expect(issuesOf(() => validate([step('a', 't', ['a'])]))).toEqual(['Circular dependency involving steps: a']);
  });

  it('rejects unknown tasks', () => {
    expect(issuesOf(() => validate([step('a', 'nope')]))).toEqual(['Step "a" uses unknown task "nope"']);
  });

  it('reports every issue at once', () => {
    const issues = issuesOf(() =>
      validate([step('a', 't'), step('a', 'nope'), step('b', 't', ['missing'], { x: '{{ ( }}' })])
    );
    expect(issues).toHaveLength(4);
  });

  it('rejects invalid expressions, naming the step and param', () => {
    const [issue] = issuesOf(() => validate([step('a', 't', [], { query: { q: '{{ input. }}' } })], { org: 'string' }));
    expect(issue).toMatch(/^Step "a" params\.query\.q: invalid expression/);
  });

  it('allows references to direct and indirect dependencies', () => {
    expect(() =>
      validate([
        step('a', 't'),
        step('b', 't', ['a']),
        step('c', 't', ['b'], { x: '{{ steps.a.output }}', y: '{{ steps.b.output }}' }),
      ])
    ).not.toThrow();
  });

  it('rejects references to steps that are not upstream, or do not exist', () => {
    const issues = issuesOf(() =>
      validate([
        step('a', 't'),
        step('b', 't', [], { x: '{{ steps.a.output }}' }),
        step('c', 't', ['a'], { y: 'id: {{ steps.nope.output }}' }),
      ])
    );
    expect(issues).toEqual([
      'Step "b" params.x references step "a", which it does not depend on',
      'Step "c" params.y references unknown step "nope"',
    ]);
  });

  it('rejects references to undeclared input', () => {
    expect(issuesOf(() => validate([step('a', 't', [], { x: '{{ input.org }}' })]))).toEqual([
      'Step "a" params.x references undeclared input "org"',
    ]);
  });

  it("checks params against the task's schema, skipping values that are expressions", () => {
    const tasks = lookup({ typed });
    const check = (params: object) => () =>
      validateWorkflow(workflow([step('a', 'typed', [], params)], { u: 'string' }), tasks);

    expect(issuesOf(check({ url: 'ftp://x', retries: 9, extra: 1 }))).toEqual([
      'Step "a" params must NOT have additional properties',
      'Step "a" params.url must match pattern "^https?://"',
      'Step "a" params.retries must be <= 5',
    ]);
    expect(issuesOf(check({}))).toEqual(["Step \"a\" params must have required property 'url'"]);
    expect(() => check({ url: '{{ input.u }}' })()).not.toThrow();
    expect(() => check({ url: 'https://{{ input.u }}' })()).not.toThrow();
  });

  it("runs the task's own checks", () => {
    expect(issuesOf(() => validateWorkflow(workflow([step('a', 'typed', [], { url: 'http://forbidden' })]), lookup({ typed })))).toEqual([
      'Step "a" params.url is forbidden',
    ]);
  });

  it('rejects unknown input types and invalid input schemas', () => {
    const issues = issuesOf(() => validate([step('a', 't')], { a: 'text', b: { type: 'nope' } }));
    expect(issues[0]).toContain('input.a: unknown type "text"');
    expect(issues[1]).toContain('input: invalid schema');
  });
});

describe('runWorkflow', () => {
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('wires each step to earlier outputs and run input through expressions', async () => {
    const tasks = lookup({
      one: fakeTask(async () => 1),
      add: fakeTask(async ({ params }: TaskContext<{ a: number; b: number }>) => params.a + params.b),
    });

    const results = await runWorkflow(
      workflow(
        [
          step('a', 'one'),
          step('b', 'add', ['a'], { a: '{{ steps.a.output }}', b: '{{ input.n }}' }),
          step('c', 'add', ['b'], { a: '{{ steps.b.output }}', b: 3 }),
        ],
        { n: 'number' }
      ),
      tasks,
      { ...quiet, input: { n: 2 } }
    );

    expect(outputs(results)).toEqual({ a: 1, b: 3, c: 6 });
    expect(results.steps.a.status).toBe('succeeded');
  });

  it('runs each step of a diamond once, after all of its dependencies', async () => {
    const calls: string[] = [];
    const record = fakeTask(async ({ params }: TaskContext<{ name: string; value?: unknown }>) => {
      calls.push(params.name);
      return params.value;
    });

    const results = await runWorkflow(
      workflow([
        step('d', 't', ['b', 'c'], { name: 'join', value: '{{ [steps.b.output, steps.c.output] }}' }),
        step('b', 't', ['a'], { name: 'left', value: 'l' }),
        step('c', 't', ['a'], { name: 'right', value: '{{ steps.a.output }}' }),
        step('a', 't', [], { name: 'root', value: 'r' }),
      ]),
      lookup({ t: record }),
      quiet
    );

    expect(calls).toHaveLength(4);
    expect(calls[0]).toBe('root');
    expect(calls[3]).toBe('join');
    expect(results.steps.d.output).toEqual(['l', 'r']);
  });

  it('lets steps depend on tasks that return falsy values', async () => {
    const tasks = lookup({ nothing: fakeTask(async () => undefined), zero: fakeTask(async () => 0), echo });

    const results = await runWorkflow(
      workflow([step('a', 'nothing'), step('b', 'zero', ['a']), step('c', 'echo', ['a', 'b'], { b: '{{ steps.b.output }}' })]),
      tasks,
      quiet
    );

    expect(results.steps.c.output).toEqual({ b: 0 });
  });

  it('shows a step only the outputs of its upstream steps', async () => {
    const results = await runWorkflow(
      workflow([step('a', 't', [], { v: 'a' }), step('b', 't', [], { v: 'b' }), step('c', 't', ['a'], { scope: '{{ $$ }}' })]),
      anyTasks,
      quiet
    );

    expect(results.steps.c.output).toEqual({ scope: { input: {}, steps: { a: { output: { v: 'a' } } } } });
  });

  it('rejects an invalid definition before running any task', async () => {
    const execute = jest.fn(async () => 1);

    await expect(
      runWorkflow(workflow([step('a', 't'), step('b', 't', ['missing'])]), lookup({ t: fakeTask(execute) }), quiet)
    ).rejects.toBeInstanceOf(WorkflowDefinitionError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates run input, fills in defaults and leaves the caller\'s object alone', async () => {
    const definition = workflow([step('a', 't', [], { org: '{{ input.org }}', min: '{{ input.min }}' })], {
      org: 'string',
      min: { type: 'integer', default: 10 },
    });
    const input = { org: 'nestjs' };

    const results = await runWorkflow(definition, anyTasks, { ...quiet, input });
    expect(results.steps.a.output).toEqual({ org: 'nestjs', min: 10 });
    expect(input).toEqual({ org: 'nestjs' });

    const error = await runWorkflow(definition, anyTasks, { ...quiet, input: { min: 'x', extra: 1 } }).catch(e => e);
    expect(error).toBeInstanceOf(RunInputError);
    expect(error.issues).toEqual([
      "input must have required property 'org'",
      'input must NOT have additional properties',
      'input.min must be integer',
    ]);
  });

  it('wraps a task failure with its cause and stops later steps', async () => {
    const after = jest.fn(async () => 1);
    const tasks = lookup({
      boom: fakeTask(async () => {
        throw new Error('kaput');
      }),
      after: fakeTask(after),
    });

    const run = runWorkflow(workflow([step('a', 'boom'), step('b', 'after', ['a'])]), tasks, quiet);

    await expect(run).rejects.toBeInstanceOf(TaskExecutionError);
    await expect(run).rejects.toMatchObject({
      taskId: 'a',
      taskName: 'boom',
      message: 'Task execution failed: kaput',
      cause: expect.objectContaining({ message: 'kaput' }),
    });
    expect(after).not.toHaveBeenCalled();
  });

  it('fails the step when an expression fails while its params are resolved', async () => {
    await expect(runWorkflow(workflow([step('a', 't', [], { x: '{{ $error("nope") }}' })]), anyTasks, quiet)).rejects.toMatchObject({
      name: 'TaskExecutionError',
      taskId: 'a',
      message: 'Could not resolve params: params.x: expression "$error("nope")" failed: nope',
    });
  });

  it('validates resolved params before the task runs, filling in defaults', async () => {
    const definition = workflow([step('a', 'typed', [], { url: '{{ input.u }}' })], { u: 'string' });

    const ok = await runWorkflow(definition, lookup({ typed }), { ...quiet, input: { u: 'https://x' } });
    expect(ok.steps.a.output).toEqual({ url: 'https://x', retries: 1 });

    await expect(runWorkflow(definition, lookup({ typed }), { ...quiet, input: { u: 'nope' } })).rejects.toMatchObject({
      name: 'TaskExecutionError',
      taskId: 'a',
      message: 'Invalid params: params.url must match pattern "^https?://"',
    });
  });

  it('hands each step a context for its first attempt', async () => {
    const execute = jest.fn(async () => 1);
    const contexts: string[] = [];

    await runWorkflow(workflow([step('a', 't', [], { n: 1 }), step('b', 't', ['a'])]), lookup({ t: fakeTask(execute) }), {
      runId: 'run-1',
      createLogger: context => {
        contexts.push(context);
        return silentLogger;
      },
    });

    const [[first], [second]] = execute.mock.calls as unknown as [TaskContext][];
    expect(first).toMatchObject({ params: { n: 1 }, attempt: 1, idempotencyKey: 'run-1:a' });
    expect(first.signal).toBeInstanceOf(AbortSignal);
    expect(first.signal.aborted).toBe(false);
    expect(second).toMatchObject({ params: {}, idempotencyKey: 'run-1:b' });
    expect(contexts).toEqual(['t run=run-1 step=a', 't run=run-1 step=b']);
  });

  it('gives each run its own id', async () => {
    const first = await runWorkflow(workflow([step('a', 't')]), anyTasks, quiet);
    const second = await runWorkflow(workflow([step('a', 't')]), anyTasks, quiet);

    expect(first.runId).not.toBe(second.runId);
  });
});
