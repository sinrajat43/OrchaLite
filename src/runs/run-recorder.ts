import { applyEvent } from './run-projection';
import { DuplicateEventError, RunStore } from './run-store';
import { RunEvent, RunEventType, RunSummary } from './run.types';

const MAX_APPEND_ATTEMPTS = 10;

/**
 * A run's summary, brought up to date with its events. A process that died
 * between writing an event and its summary leaves the summary behind, and
 * deciding anything from that stale copy would repeat what already happened.
 */
export async function readRun(store: RunStore, runId: string): Promise<RunSummary | null> {
  const stored = await store.getRun(runId);
  if (!stored) return null;
  const later = await store.getEvents(runId, stored.lastSeq);
  if (!later.length) return stored;
  const current = later.reduce<RunSummary>(applyEvent, stored);
  await store.saveSummary(current, stored.lastSeq);
  return current;
}

/**
 * Appends an event to a run with optimistic concurrency: read the version
 * (lastSeq), claim the next seq through the unique (runId, seq) index, and on a
 * collision start over from the newer state. Any number of writers can share a run.
 * A summary left behind by a crash between the two writes is caught up from the
 * events first, so it repairs itself on the next append.
 * @throws IllegalTransitionError if the run's state machine does not allow the event
 */
export async function appendRunEvent(store: RunStore, runId: string, type: RunEventType, data: Record<string, any>, at = new Date()): Promise<RunSummary> {
  // Undefined fields are dropped so the stored event matches what replay sees
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const stored = await store.getRun(runId);
    const storedSeq = stored?.lastSeq ?? 0;
    const current = (await store.getEvents(runId, storedSeq)).reduce<RunSummary | null>(applyEvent, stored);
    const event: RunEvent = { runId, seq: (current?.lastSeq ?? 0) + 1, type, at, data: clean };
    const next = applyEvent(current, event);
    try {
      // Event first: if the process dies before the summary write, the next append repairs it
      await store.appendEvent(event);
    } catch (error) {
      if (error instanceof DuplicateEventError) continue;
      throw error;
    }
    // A failed check means another writer already moved the summary on; the events still hold this one
    await store.saveSummary(next, storedSeq);
    return next;
  }
  throw new Error(`Run ${runId}: gave up appending ${type} after ${MAX_APPEND_ATTEMPTS} conflicts`);
}

/** Step outputs larger than this are stored as a preview only */
export const MAX_OUTPUT_BYTES = 256 * 1024;
const PREVIEW_CHARS = 2000;

/**
 * Shapes a step output for storage, replacing anything over the cap with a preview
 */
export function capOutput(output: any): any {
  if (output === undefined) return undefined;
  const json = JSON.stringify(output);
  const sizeBytes = Buffer.byteLength(json ?? '');
  if (sizeBytes <= MAX_OUTPUT_BYTES) return output;
  return { truncated: true, sizeBytes, preview: json.slice(0, PREVIEW_CHARS) };
}
