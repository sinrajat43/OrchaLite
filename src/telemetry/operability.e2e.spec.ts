import { ServerResponse } from 'http';
import { startTestApi, TestApi } from '../testing/api-app';
import { buildEngine, EngineProcess, startEngineProcess } from '../testing/engine-process';
import { sendJson, startTestServer, TestServer } from '../testing/http-server';
import { until } from '../testing/wait';
import { memorySpans, traceIdOf } from './telemetry';

describe('operability', () => {
  let api: TestApi;
  let upstream: TestServer;
  let logs: Record<string, any>[] = [];
  const held: ServerResponse[] = [];

  const result = (runId: string) => api.request('GET', `/runs/${runId}/result`).then(r => r.body);
  const active = ['RUNNING', 'COMPENSATING', 'CANCELLING'];
  const finished = (runId: string) => until(() => result(runId), body => !active.includes(body.status), `run ${runId}`);
  const start = async (definition: unknown, input?: unknown) => (await api.request('POST', '/workflow/run', { definition, input })).body.runId as string;

  const capture = (line: unknown) => {
    try {
      const parsed = JSON.parse(String(line));
      if (parsed?.time) logs.push(parsed);
    } catch {
      // Not one of ours
    }
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(capture);
    jest.spyOn(console, 'warn').mockImplementation(capture);
    jest.spyOn(console, 'error').mockImplementation(capture);
    upstream = await startTestServer((req, res) => {
      if (req.url.startsWith('/hang')) return void held.push(res);
      if (req.url === '/broken') return sendJson(res, 503, { error: 'db on fire' });
      sendJson(res, 200, { ok: true, url: req.url });
    });
    process.env.ORCHALITE_TRACES = 'memory';
    process.env.ORCHALITE_SCHEDULER_INTERVAL_MS = '50';
    process.env.ORCHALITE_WORKER_POLL_MS = '20';
    api = await startTestApi();
  }, 60_000);

  afterAll(async () => {
    held.forEach(res => res.destroy());
    await api.close();
    await upstream.close();
    delete process.env.ORCHALITE_TRACES;
    delete process.env.ORCHALITE_SCHEDULER_INTERVAL_MS;
    delete process.env.ORCHALITE_WORKER_POLL_MS;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    logs = [];
  });

  it('a failed run can be diagnosed from telemetry alone', async () => {
    const runId = await start({
      name: 'diagnose-me',
      steps: [
        { id: 'fine', task: 'transform', params: { value: 1 }, dependsOn: [] },
        { id: 'charge', task: 'http.request', params: { method: 'POST', url: `${upstream.url}/broken` }, retry: { maxAttempts: 2, backoffMs: 5 }, dependsOn: ['fine'] },
      ],
    });
    await finished(runId);

    // Traces: one trace per run, one span per attempt, saying which step failed and why
    const traceId = traceIdOf(runId);
    const spans = await until(async () => memorySpans().filter(span => span.spanContext().traceId === traceId), list => list.some(s => s.name === 'run diagnose-me'), 'the run span');
    const names = spans.map(span => span.name).sort();
    expect(names).toEqual(['run diagnose-me', 'step charge', 'step charge', 'step fine']);

    const runSpan = spans.find(span => span.name === 'run diagnose-me');
    expect(runSpan.attributes).toMatchObject({ 'run.id': runId, 'run.status': 'FAILED', 'run.failed_step': 'charge' });
    expect(runSpan.status.message).toContain('HTTP 503');

    const charges = spans.filter(span => span.name === 'step charge').sort((a, b) => (a.attributes['step.attempt'] as number) - (b.attributes['step.attempt'] as number));
    expect(charges.map(span => [span.attributes['step.attempt'], span.attributes['step.outcome']])).toEqual([[1, 'retried'], [2, 'dead_lettered']]);
    expect(charges[1].attributes['error.message']).toContain('db on fire');
    expect(charges[1].attributes['task.name']).toBe('http.request');
    // Every step span hangs off the run's span, though no process passed anything to another
    for (const span of spans.filter(s => s !== runSpan)) expect(span.parentSpanId).toBe(runSpan.spanContext().spanId);

    // Logs: filterable by the same ids, and joined to the trace
    const failure = await until(async () => logs.filter(line => line.runId === runId && line.stepId === 'charge' && line.level === 'error'), list => list.length > 0, 'the failure log');
    expect(failure[0]).toMatchObject({ traceId, task: 'http.request', workerId: expect.any(String) });
    expect(failure[0].message).toContain('dead-lettered');
    expect(logs.find(line => line.runId === runId && line.attempt === 1)).toMatchObject({ level: 'warn', stepId: 'charge' });

    // Metrics: the retry and the dead letter show up in the rates
    const metrics: string = await fetch(`${api.url}/metrics`).then(r => r.text());
    expect(metrics).toMatch(/orchalite_step_attempts_total\{task="http.request",outcome="retried"\} [1-9]/);
    expect(metrics).toMatch(/orchalite_step_attempts_total\{task="http.request",outcome="dead_lettered"\} [1-9]/);
    expect(metrics).toMatch(/orchalite_runs_ended_total\{status="FAILED"\} [1-9]/);
    expect(metrics).toMatch(/orchalite_step_duration_seconds_count\{task="transform",outcome="succeeded"\} [1-9]/);
    expect(metrics).toMatch(/orchalite_queue_depth\{state="ready"\} \d/);
    expect(metrics).toMatch(/orchalite_runs_active \d/);
  });

  it('does not put step params in logs or traces, where a secret could leak', async () => {
    const runId = await start({ name: 'secret-free', steps: [{ id: 'a', task: 'transform', params: { value: 'hunter2' }, dependsOn: [] }] });
    await finished(runId);

    expect(JSON.stringify(logs)).not.toContain('hunter2');
    const spans = memorySpans().filter(span => span.spanContext().traceId === traceIdOf(runId));
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain('hunter2');
  });

  describe('cancel', () => {
    it('aborts running steps, skips the rest, and ends the run', async () => {
      const runId = await start({
        name: 'cancel-me',
        steps: [
          { id: 'slow', task: 'http.request', params: { url: `${upstream.url}/hang/1` }, dependsOn: [] },
          { id: 'after', task: 'transform', params: { value: 1 }, dependsOn: ['slow'] },
        ],
      });
      await until(() => result(runId), body => body.steps.slow.status === 'running', 'the slow step to start');

      const cancelled = await api.request('POST', `/runs/${runId}/cancel`);
      expect(cancelled.status).toBe(202);
      expect(cancelled.body.status).toBe('CANCELLING');

      const run = await finished(runId);
      expect(run).toMatchObject({
        status: 'CANCELLED',
        steps: { slow: { status: 'cancelled' }, after: { status: 'skipped', reason: 'the run was cancelled' } },
      });
      const types = ((await api.request('GET', `/runs/${runId}/events`)).body as any[]).map(e => e.type);
      expect(types).toEqual(expect.arrayContaining(['RunCancelling', 'StepCancelled', 'StepSkipped']));
      expect(types.at(-1)).toBe('RunCancelled');
    });

    it('winds down a fan-out', async () => {
      const runId = await start({
        name: 'cancel-fan-out',
        steps: [{ id: 'each', task: 'http.request', forEach: '{{ [1..50] }}', concurrency: 2, params: { url: `${upstream.url}/hang/{{ item }}` }, dependsOn: [] }],
      });
      await until(() => result(runId), body => body.steps.each.status === 'running', 'the fan-out to start');

      await api.request('POST', `/runs/${runId}/cancel`);

      expect(await finished(runId)).toMatchObject({ status: 'CANCELLED', steps: { each: { status: 'cancelled' } } });
    });

    it('refuses to cancel a run that has ended, or does not exist', async () => {
      const runId = await start({ name: 'done', steps: [{ id: 'a', task: 'transform', params: { value: 1 }, dependsOn: [] }] });
      await finished(runId);

      expect((await api.request('POST', `/runs/${runId}/cancel`)).status).toBe(409);
      expect((await api.request('POST', '/runs/0123456789abcdef01234567/cancel')).status).toBe(404);
    });
  });

  describe('retry from the failed step', () => {
    it('keeps what succeeded and runs the rest', async () => {
      let broken = true;
      const flaky = await startTestServer((_req, res) => sendJson(res, broken ? 503 : 200, { broken }));
      const callsTo = (path: string) => upstream.requests.filter(r => r.url === path).length;
      const runId = await start({
        name: 'retry-me',
        steps: [
          { id: 'once', task: 'http.request', params: { url: `${upstream.url}/only-once` }, dependsOn: [] },
          { id: 'flaky', task: 'http.request', params: { url: `${flaky.url}/x` }, dependsOn: ['once'] },
          { id: 'last', task: 'transform', params: { value: '{{ steps.once.output.body.url }}' }, dependsOn: ['flaky'] },
        ],
      });
      expect(await finished(runId)).toMatchObject({ status: 'FAILED', failedStepId: 'flaky', steps: { last: { status: 'skipped' } } });

      broken = false;
      const retried = await api.request('POST', `/runs/${runId}/retry`);
      expect(retried.status).toBe(202);

      const run = await finished(runId);
      expect(run).toMatchObject({ status: 'SUCCEEDED', steps: { flaky: { status: 'succeeded' }, last: { output: '/only-once' } } });
      expect(run.error).toBeUndefined();
      expect(callsTo('/only-once')).toBe(1);
      expect(flaky.requests).toHaveLength(2);
      await flaky.close();
    });

    it('re-runs only the items of a fan-out that did not succeed', async () => {
      let broken = true;
      const flaky = await startTestServer((req, res) => sendJson(res, broken && req.url === '/2' ? 400 : 200, { url: req.url }));
      const runId = await start({
        name: 'retry-items',
        steps: [{ id: 'each', task: 'http.request', forEach: '{{ [1, 2, 3] }}', concurrency: 1, params: { url: `${flaky.url}/{{ item }}` }, dependsOn: [] }],
      });
      expect((await finished(runId)).status).toBe('FAILED');
      const callsBefore = flaky.requests.length;

      broken = false;
      await api.request('POST', `/runs/${runId}/retry`);

      const run = await finished(runId);
      expect(run.status).toBe('SUCCEEDED');
      expect(run.steps.each.output.map((o: any) => o.body.url)).toEqual(['/1', '/2', '/3']);
      expect(flaky.requests.filter(r => r.url === '/1')).toHaveLength(1);
      expect(flaky.requests.length).toBeGreaterThan(callsBefore);
      await flaky.close();
    });

    it('refuses a run that succeeded, or is still going', async () => {
      const runId = await start({ name: 'ok', steps: [{ id: 'a', task: 'transform', params: { value: 1 }, dependsOn: [] }] });
      await finished(runId);
      expect((await api.request('POST', `/runs/${runId}/retry`)).status).toBe(409);
      expect((await api.request('POST', '/runs/0123456789abcdef01234567/retry')).status).toBe(404);
    });

    it('keeps the timeline a valid replay across the retry', async () => {
      const { replay } = await import('../runs/run-projection');
      const runId = await start({ name: 'replay', steps: [{ id: 'a', task: 'http.request', params: { url: `${upstream.url}/broken` }, dependsOn: [] }] });
      await finished(runId);
      await api.request('POST', `/runs/${runId}/retry`);
      await finished(runId);

      const events = (await api.request('GET', `/runs/${runId}/events`)).body as any[];
      expect(events.map(e => e.type)).toEqual(['RunStarted', 'StepStarted', 'StepFailed', 'RunFailed', 'RunRetried', 'StepStarted', 'StepFailed', 'RunFailed']);
      const revived = events.map(e => ({ ...e, at: new Date(e.at) }));
      expect(replay(revived)!.status).toBe('FAILED');
    });
  });
});

describe('graceful shutdown', () => {
  let api: TestApi;
  let upstream: TestServer;
  const processes: EngineProcess[] = [];
  const held: ServerResponse[] = [];

  const worker = (env: Record<string, string> = {}) => {
    const started = startEngineProcess({ MONGODB_URI: api.mongoUri, ORCHALITE_ROLES: 'worker', ORCHALITE_WORKER_POLL_MS: '20', ORCHALITE_LEASE_MS: '60000', ...env });
    processes.push(started);
    return started;
  };
  const result = (runId: string) => api.request('GET', `/runs/${runId}/result`).then(r => r.body);
  const definition = (path: string) => ({ name: 'drain', steps: [{ id: 'call', task: 'http.request', params: { url: `${upstream.url}${path}` }, dependsOn: [] }] });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    buildEngine('operability');
    upstream = await startTestServer((req, res) => {
      if (req.url === '/quick') return void setTimeout(() => sendJson(res, 200, { ok: true }), 500);
      if (upstream.requests.filter(r => r.url === '/hang').length === 1) return void held.push(res);
      sendJson(res, 200, { second: true });
    });
    process.env.ORCHALITE_ROLES = 'api,scheduler';
    process.env.ORCHALITE_SCHEDULER_INTERVAL_MS = '50';
    api = await startTestApi();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(processes.map(p => p.kill()));
    held.forEach(res => res.destroy());
    await api.close();
    await upstream.close();
    delete process.env.ORCHALITE_ROLES;
    delete process.env.ORCHALITE_SCHEDULER_INTERVAL_MS;
    jest.restoreAllMocks();
  });

  it('lets a running step finish before the process exits', async () => {
    const draining = worker();
    const { runId } = (await api.request('POST', '/workflow/run', { definition: definition('/quick') })).body;
    await until(async () => upstream.requests.length, count => count === 1, 'the worker to start the step');

    await draining.stop();

    // No other worker exists, so only the one that was stopping can have finished it
    const run = await until(() => result(runId), body => body.status !== 'RUNNING', 'the run to finish', 10_000);
    expect(run).toMatchObject({ status: 'SUCCEEDED', steps: { call: { output: { status: 200 } } } });
  }, 60_000);

  it('hands a step back when it outlasts the grace period, without waiting out the lease', async () => {
    upstream.requests.length = 0;
    const draining = worker({ ORCHALITE_SHUTDOWN_GRACE_MS: '100' });
    const { runId } = (await api.request('POST', '/workflow/run', { definition: definition('/hang') })).body;
    await until(async () => upstream.requests.length, count => count === 1, 'the worker to start the step');

    await draining.stop();
    const stoppedAt = Date.now();
    worker();

    const run = await until(() => result(runId), body => body.status !== 'RUNNING', 'another worker to finish it', 20_000);
    expect(run).toMatchObject({ status: 'SUCCEEDED', steps: { call: { output: { body: { second: true } } } } });
    // The lease is 60 seconds, so this was a handover, not an expiry
    expect(Date.now() - stoppedAt).toBeLessThan(15_000);
    expect(upstream.requests).toHaveLength(2);
  }, 60_000);
});
