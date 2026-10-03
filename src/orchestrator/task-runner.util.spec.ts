import { runWorkflow, validateWorkflow, WorkflowDefinitionError, WorkflowStep } from './task-runner.util';
import { TaskExecutionError, TaskRegistry } from '../tasks/task.interface';

const step = (id: string, task: string, dependsOn: string[] = [], params?: any): WorkflowStep => ({
  id,
  task,
  params,
  dependsOn,
});

const issuesOf = (fn: () => void): string[] => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowDefinitionError);
    return (error as WorkflowDefinitionError).issues;
  }
  throw new Error('Expected WorkflowDefinitionError');
};

describe('validateWorkflow', () => {
  it('accepts a valid DAG regardless of declaration order', () => {
    expect(() =>
      validateWorkflow([step('c', 't', ['a', 'b']), step('b', 't', ['a']), step('a', 't')])
    ).not.toThrow();
  });

  it('rejects duplicate step ids', () => {
    expect(issuesOf(() => validateWorkflow([step('a', 't'), step('a', 't')]))).toEqual([
      'Duplicate step id "a"',
    ]);
  });

  it('rejects dependencies on unknown steps', () => {
    expect(issuesOf(() => validateWorkflow([step('a', 't', ['missing'])]))).toEqual([
      'Step "a" depends on unknown step "missing"',
    ]);
  });

  it('rejects cycles and names only the steps involved', () => {
    const issues = issuesOf(() =>
      validateWorkflow([step('a', 't', ['b']), step('b', 't', ['a']), step('c', 't')])
    );
    expect(issues).toEqual(['Circular dependency involving steps: a, b']);
  });

  it('rejects a step that depends on itself', () => {
    expect(issuesOf(() => validateWorkflow([step('a', 't', ['a'])]))).toEqual([
      'Circular dependency involving steps: a',
    ]);
  });

  it('reports every issue at once', () => {
    const issues = issuesOf(() =>
      validateWorkflow([step('a', 't'), step('a', 't'), step('b', 't', ['missing'])])
    );
    expect(issues).toHaveLength(2);
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

  it('runs a linear chain in order and passes each result to the next step', async () => {
    const registry: TaskRegistry = {
      one: { execute: async () => 1 },
      addParam: { execute: async (input: number, params: { n: number }) => input + params.n },
    };

    const results = await runWorkflow(
      [step('a', 'one'), step('b', 'addParam', ['a'], { n: 2 }), step('c', 'addParam', ['b'], { n: 3 })],
      registry
    );

    expect(results).toEqual({ a: 1, b: 3, c: 6 });
  });

  it('runs each step of a diamond once and passes multiple inputs as an array', async () => {
    const calls: string[] = [];
    const record = (name: string, value: any) => ({
      execute: async (input: any) => {
        calls.push(name);
        return value ?? input;
      },
    });
    const registry: TaskRegistry = {
      root: record('root', 'r'),
      left: record('left', 'l'),
      right: record('right', 'x'),
      join: record('join', undefined),
    };

    const results = await runWorkflow(
      [step('d', 'join', ['b', 'c']), step('b', 'left', ['a']), step('c', 'right', ['a']), step('a', 'root')],
      registry
    );

    expect(calls).toHaveLength(4);
    expect(calls[0]).toBe('root');
    expect(calls[3]).toBe('join');
    expect(results.d).toEqual(['l', 'x']);
  });

  it('lets steps depend on tasks that return falsy values', async () => {
    const registry: TaskRegistry = {
      nothing: { execute: async () => undefined },
      zero: { execute: async () => 0 },
      echo: { execute: async (input: any) => input },
    };

    const results = await runWorkflow(
      [step('a', 'nothing'), step('b', 'zero', ['a']), step('c', 'echo', ['a', 'b'])],
      registry
    );

    expect(results.c).toEqual([undefined, 0]);
  });

  it('rejects an invalid definition before running any task', async () => {
    const execute = jest.fn(async () => 1);

    await expect(
      runWorkflow([step('a', 't'), step('b', 't', ['missing'])], { t: { execute } })
    ).rejects.toBeInstanceOf(WorkflowDefinitionError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails when a task is not in the registry', async () => {
    await expect(runWorkflow([step('a', 'nope')], {})).rejects.toMatchObject({
      name: 'TaskExecutionError',
      taskId: 'a',
      taskName: 'nope',
      message: 'Task nope not found in registry',
    });
  });

  it('wraps a task failure with its cause and stops later steps', async () => {
    const after = jest.fn(async () => 1);
    const registry: TaskRegistry = {
      boom: {
        execute: async () => {
          throw new Error('kaput');
        },
      },
      after: { execute: after },
    };

    const run = runWorkflow([step('a', 'boom'), step('b', 'after', ['a'])], registry);

    await expect(run).rejects.toBeInstanceOf(TaskExecutionError);
    await expect(run).rejects.toMatchObject({
      taskId: 'a',
      taskName: 'boom',
      message: 'Task execution failed: kaput',
      cause: expect.objectContaining({ message: 'kaput' }),
    });
    expect(after).not.toHaveBeenCalled();
  });
});
