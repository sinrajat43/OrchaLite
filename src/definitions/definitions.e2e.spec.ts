import { DefinitionStore } from './definition-store.service';
import { startTestApi, TestApi } from '../testing/api-app';

describe('stored workflow definitions', () => {
  let api: TestApi;

  const definition = (value: unknown) => ({
    name: 'double',
    input: { n: 'number' },
    steps: [{ id: 'calc', task: 'transform', params: { value }, dependsOn: [] }],
  });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    api = await startTestApi();
  }, 60_000);

  afterAll(async () => {
    await api.close();
    jest.restoreAllMocks();
  });

  it('versions a definition each time it changes, and not when it is resubmitted unchanged', async () => {
    expect(await api.request('POST', '/workflows', definition('{{ input.n * 2 }}'))).toEqual({
      status: 201,
      body: { name: 'double', version: 1, created: true },
    });
    expect((await api.request('POST', '/workflows', definition('{{ input.n * 2 }}'))).body).toEqual({
      name: 'double',
      version: 1,
      created: false,
    });
    expect((await api.request('POST', '/workflows', definition('{{ input.n * 3 }}'))).body.version).toBe(2);

    const latest = await api.request('GET', '/workflows/double');
    expect(latest.body).toMatchObject({ name: 'double', version: 2, definition: definition('{{ input.n * 3 }}') });
    expect((await api.request('GET', '/workflows/double/versions')).body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await api.request('GET', '/workflows/double/versions/1')).body.definition).toEqual(definition('{{ input.n * 2 }}'));
    expect((await api.request('GET', '/workflows')).body).toEqual([
      { name: 'double', latestVersion: 2, versions: 2, updatedAt: expect.any(String) },
    ]);
  });

  it('runs the latest stored version, or the one asked for', async () => {
    const latest = await api.request('POST', '/workflows/double/runs?wait=true', { input: { n: 5 } });
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({ workflow: { name: 'double', version: 2 }, steps: { calc: { output: 15 } } });

    const pinned = await api.request('POST', '/workflows/double/runs?wait=true', { input: { n: 5 }, version: 1 });
    expect(pinned.body).toMatchObject({ workflow: { version: 1 }, steps: { calc: { output: 10 } } });

    expect((await api.request('POST', '/workflows/double/runs?wait=true', { input: { n: 'x' } })).body.message).toBe('Invalid run input');
  });

  it('records stored runs in MongoDB with the workflow version they ran', async () => {
    const { body } = await api.request('POST', '/workflows/double/runs?wait=true', { input: { n: 4 }, version: 1 });

    const run = await api.request('GET', `/runs/${body.runId}`);
    expect(run.body).toMatchObject({
      id: body.runId,
      name: 'double',
      status: 'SUCCEEDED',
      workflow: { name: 'double', version: 1 },
      input: { n: 4 },
      steps: [{ id: 'calc', status: 'SUCCEEDED' }],
    });
    const events = await api.request('GET', `/runs/${body.runId}/events`);
    expect(events.body.find((e: { type: string }) => e.type === 'StepSucceeded').data.output).toBe(8);

    const list = await api.request('GET', '/runs?name=double&limit=50');
    // Three accepted runs so far (latest, pinned, this one); the rejected input made none
    expect(list.body).toHaveLength(3);
    expect(list.body[0].id).toBe(body.runId);
  });

  it('refuses to store an invalid definition', async () => {
    const bad = { name: 'bad', steps: [{ id: 'a', task: 'nope', dependsOn: [] }] };

    expect(await api.request('POST', '/workflows', bad)).toMatchObject({
      status: 400,
      body: { message: 'Invalid workflow definition', errors: ['Step "a" uses unknown task "nope"'] },
    });
    expect((await api.request('GET', '/workflows/bad')).status).toBe(404);
  });

  it('answers 404 for unknown workflows and versions', async () => {
    expect((await api.request('GET', '/workflows/missing')).status).toBe(404);
    expect((await api.request('GET', '/workflows/double/versions/9')).status).toBe(404);
    expect((await api.request('POST', '/workflows/missing/runs', {})).status).toBe(404);
  });

  it('gives concurrent saves distinct versions', async () => {
    const store = new DefinitionStore();
    const saves = await Promise.all(
      [1, 2, 3, 4, 5].map(n => store.save({ ...definition(n), name: 'racy' }))
    );

    expect(saves.map(s => s.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
