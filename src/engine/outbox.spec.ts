import { InMemoryRunStore } from '../runs/in-memory-run-store';
import { appendRunEvent } from '../runs/run-recorder';
import { RunEvent } from '../runs/run.types';
import { OutboxRelay } from './outbox';

describe('OutboxRelay', () => {
  const started = { definition: { name: 'x', steps: [] as unknown[] }, input: {} };

  beforeEach(() => jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('publishes each event, and only once when all goes well', async () => {
    const store = new InMemoryRunStore();
    const seen: RunEvent[] = [];
    const relay = new OutboxRelay(store, { publish: async events => void seen.push(...events) }, 1000);
    await appendRunEvent(store, 'r', 'RunStarted', started);
    await appendRunEvent(store, 'r', 'RunSucceeded', {});

    await relay.drain();
    await relay.drain();

    expect(seen.map(e => e.seq)).toEqual([1, 2]);
  });

  it('loses nothing when publishing fails, and sends it again', async () => {
    const store = new InMemoryRunStore();
    const seen: RunEvent[] = [];
    let down = true;
    const relay = new OutboxRelay(
      store,
      {
        publish: async events => {
          if (down) throw new Error('down');
          seen.push(...events);
        },
      },
      1000
    );
    await appendRunEvent(store, 'r', 'RunStarted', started);

    await relay.drain();
    expect(seen).toEqual([]);

    down = false;
    await relay.drain();
    expect(seen.map(e => e.seq)).toEqual([1]);
  });

  it('sends a batch again if it dies between publishing and marking: at-least-once', async () => {
    const store = new InMemoryRunStore();
    const seen: RunEvent[] = [];
    const relay = new OutboxRelay(store, { publish: async events => void seen.push(...events) }, 1000);
    await appendRunEvent(store, 'r', 'RunStarted', started);
    jest.spyOn(store, 'markEventsPublished').mockRejectedValueOnce(new Error('crash'));

    await relay.drain();
    await relay.drain();

    expect(seen.map(e => e.seq)).toEqual([1, 1]);
  });
});
