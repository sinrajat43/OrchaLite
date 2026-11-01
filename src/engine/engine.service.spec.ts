import { InMemoryRunStore } from '../runs/in-memory-run-store';
import { appendRunEvent } from '../runs/run-recorder';
import { noTelemetry } from '../telemetry/telemetry';
import { EngineOptions } from './engine-options';
import { EngineService } from './engine.service';
import { EngineSignals } from './engine-signals';
import { InMemoryStepQueue } from './in-memory-step-queue';
import { InMemoryLeaderLock } from './leader-lock';
import { LeaderState } from './leader-state';
import { InMemoryRateLimiter } from './rate-limiter';

const definition = { name: 'test', steps: [] as never[] };

describe('EngineService', () => {
  let store: InMemoryRunStore;

  const engine = (roles: EngineOptions['roles']) =>
    new EngineService(
      store,
      new InMemoryStepQueue(),
      new InMemoryRateLimiter(),
      new InMemoryLeaderLock(),
      { roles, schedulerIntervalMs: 1000, runWindow: 16, taskLimits: {}, leaderTtlMs: 60_000 } as EngineOptions,
      new LeaderState(),
      noTelemetry,
      new Map() as any,
      {} as any,
      new EngineSignals()
    );

  beforeEach(async () => {
    store = new InMemoryRunStore();
    await appendRunEvent(store, 'legacy', 'RunStarted', { definition });
    await appendRunEvent(store, 'queued', 'RunStarted', { definition, execution: 'queue' });
  });

  const start = async (roles: EngineOptions['roles']) => {
    const service = engine(roles);
    await service.onApplicationBootstrap();
    await service.beforeApplicationShutdown();
  };

  it('closes runs from before the queue on startup, and leaves the ones it can recover', async () => {
    await start(['scheduler']);

    expect(await store.getRun('legacy')).toMatchObject({ status: 'ABANDONED', error: expect.stringContaining('server stopped') });
    expect((await store.getRun('queued')).status).not.toBe('ABANDONED');
  });

  it('leaves that to the schedulers', async () => {
    await start(['api']);

    expect((await store.getRun('legacy')).status).toBe('RUNNING');
  });

  it('starts anyway if that check fails, since it only tidies up', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(store, 'findRunning').mockRejectedValueOnce(new Error('database down'));

    await expect(start(['scheduler'])).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('startup check'), expect.any(Error));
    log.mockRestore();
  });
});
