import { startTestApi, TestApi } from '../testing/api-app';
import { until } from '../testing/wait';

describe('run history across a restart', () => {
  let api: TestApi;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    api = await startTestApi();
  }, 60_000);

  afterAll(async () => {
    await api.close();
    jest.restoreAllMocks();
  });

  it("reads a run's full history back after the process restarts", async () => {
    const definition = {
      name: 'restart-demo',
      input: { n: 'integer' },
      steps: [
        { id: 'double', task: 'transform', params: { value: '{{ input.n * 2 }}' }, dependsOn: [] },
        { id: 'off', task: 'transform', params: { value: 1 }, when: '{{ false }}', dependsOn: ['double'] },
      ],
    };

    const accepted = await api.request('POST', '/workflow/run', { definition, input: { n: 21 } });
    expect(accepted.status).toBe(202);
    const { runId } = accepted.body;

    const before = await until(() => api.request('GET', `/runs/${runId}/result`), result => result.body.status !== 'RUNNING', 'the run to finish');
    expect(before.body.status).toBe('SUCCEEDED');
    const eventsBefore = (await api.request('GET', `/runs/${runId}/events`)).body;

    await api.restart();

    expect((await api.request('GET', `/runs/${runId}/result`)).body).toEqual(before.body);
    expect((await api.request('GET', `/runs/${runId}/events`)).body).toEqual(eventsBefore);
    expect(eventsBefore.map((e: { type: string }) => e.type)).toEqual([
      'RunStarted', 'StepStarted', 'StepSucceeded', 'StepStarted', 'StepSkipped', 'RunSucceeded',
    ]);
    expect((await api.request('GET', `/runs/${runId}`)).body).toMatchObject({
      status: 'SUCCEEDED',
      input: { n: 21 },
      steps: [{ id: 'double', status: 'SUCCEEDED' }, { id: 'off', status: 'SKIPPED', reason: 'when was false' }],
    });
  });

  it('applies the version check on a real database', async () => {
    const { MongoRunStore } = await import('./mongo-run-store');
    const store = new MongoRunStore();
    const summary: any = { id: 'occ-demo', name: 'x', status: 'RUNNING', startedAt: new Date(), definition: {}, steps: [], lastSeq: 1 };

    expect(await store.saveSummary(summary, 0)).toBe(true);
    expect(await store.saveSummary({ ...summary, lastSeq: 2 }, 0)).toBe(false);
    expect(await store.saveSummary({ ...summary, lastSeq: 2 }, 1)).toBe(true);
    expect(await store.saveSummary({ ...summary, lastSeq: 3, status: 'FAILED' }, 1)).toBe(false);
    expect(await store.getRun('occ-demo')).toMatchObject({ status: 'RUNNING', lastSeq: 2 });
  });
});
