import { DuplicateEventError, RunStore } from './run-store';
import { RunEvent, RunQuery, RunSummary } from './run.types';

/**
 * RunStore kept in process memory, for tests. Values are cloned on the way
 * in and out so callers cannot change stored history by accident.
 */
export class InMemoryRunStore implements RunStore {
  private readonly events: RunEvent[] = [];
  private readonly runs = new Map<string, RunSummary>();

  async appendEvent(event: RunEvent): Promise<void> {
    if (this.events.some(e => e.runId === event.runId && e.seq === event.seq)) {
      throw new DuplicateEventError(event.runId, event.seq);
    }
    this.events.push(structuredClone(event));
  }

  async saveSummary(summary: RunSummary, expectedLastSeq: number): Promise<boolean> {
    if ((this.runs.get(summary.id)?.lastSeq ?? 0) !== expectedLastSeq) return false;
    this.runs.set(summary.id, structuredClone(summary));
    return true;
  }

  async listRuns({ status, name, limit, before }: RunQuery): Promise<RunSummary[]> {
    return [...this.runs.values()]
      .filter(run => (!status || run.status === status) && (!name || run.name === name) && (!before || run.id < before))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map(run => structuredClone(run));
  }

  async getRun(runId: string): Promise<RunSummary | null> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async getEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    return this.events
      .filter(e => e.runId === runId && e.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .map(e => structuredClone(e));
  }

  async findRunning(): Promise<RunSummary[]> {
    return [...this.runs.values()].filter(run => run.status === 'RUNNING').map(run => structuredClone(run));
  }
}
