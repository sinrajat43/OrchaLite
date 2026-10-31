import { Logger } from '@nestjs/common';
import axios from 'axios';
import { RunStore } from '../runs/run-store';
import { RunEvent } from '../runs/run.types';

/** Where the outbox sends run events. Kafka fits here in horizon 2. */
export interface EventPublisher {
  /** @throws Error if the events may not have arrived, and will be sent again */
  publish(events: RunEvent[]): Promise<void>;
}

/** POSTs events as a JSON array */
export class WebhookEventPublisher implements EventPublisher {
  constructor(private readonly url: string) {}

  async publish(events: RunEvent[]): Promise<void> {
    await axios.post(this.url, events, { timeout: 10_000 });
  }
}

const BATCH = 100;
const MAX_BACKOFF_MS = 30_000;

/**
 * Publishes run events reliably. The usual outbox writes a change and its event
 * in one transaction; here the event IS the change, so its one insert already
 * covers both, and `run_events` serves as the outbox. Delivery is at-least-once:
 * a crash after publishing and before marking sends a batch again, so consumers
 * deduplicate by (runId, seq), and use seq for order within a run.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private retryAt = 0;
  private failures = 0;

  constructor(
    private readonly store: RunStore,
    private readonly publisher: EventPublisher,
    private readonly intervalMs: number,
    private readonly isLeader: () => boolean = () => true
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.running || !this.isLeader() || Date.now() < this.retryAt) return;
      this.running = this.drain().finally(() => (this.running = undefined));
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Publishes until nothing is left, or a publish fails */
  async drain(): Promise<void> {
    try {
      for (;;) {
        const events = await this.store.listUnpublishedEvents(BATCH);
        if (!events.length) return;
        events.sort((a, b) => (a.runId === b.runId ? a.seq - b.seq : 0));
        await this.publisher.publish(events);
        await this.store.markEventsPublished(events);
        this.failures = 0;
        this.retryAt = 0;
      }
    } catch (error) {
      this.failures++;
      const waitMs = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.failures);
      this.retryAt = Date.now() + waitMs;
      this.logger.warn(`Outbox: publishing failed, trying again in ${waitMs} ms: ${(error as Error).message}`);
    }
  }
}
