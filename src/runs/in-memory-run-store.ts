import { InFlightCount, StepRun, StepRunExpectation, StepRunUpdateOptions } from '../engine/step-run';
import { DuplicateEventError, RunRequest, RunStore } from './run-store';
import { RunEvent, RunQuery, RunSummary } from './run.types';

/**
 * RunStore kept in process memory, for tests. Values are cloned on the way
 * in and out so callers cannot change stored history by accident.
 */
export class InMemoryRunStore implements RunStore {
  private readonly events: RunEvent[] = [];
  private readonly runs = new Map<string, RunSummary>();
  private readonly stepRuns = new Map<string, StepRun>();
  private readonly requests = new Map<string, RunRequest>();
  private readonly published = new Set<string>();

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
    return [...this.runs.values()].filter(run => ['RUNNING', 'COMPENSATING', 'CANCELLING'].includes(run.status)).map(run => structuredClone(run));
  }

  async insertStepRuns(rows: StepRun[]): Promise<void> {
    for (const row of rows) {
      if (!this.stepRuns.has(row.id)) this.stepRuns.set(row.id, structuredClone(row));
    }
  }

  async getStepRun(id: string): Promise<StepRun | null> {
    const row = this.stepRuns.get(id);
    return row ? structuredClone(row) : null;
  }

  async listStepRuns(runId: string): Promise<StepRun[]> {
    return this.rowsOf(runId).map(({ output, item, ...row }) => structuredClone(row));
  }

  async getStepOutputs(runId: string, stepIds?: string[]): Promise<Record<string, unknown>> {
    const rows = this.rowsOf(runId).filter(row => row.index === undefined && !row.compensation && (!stepIds || stepIds.includes(row.stepId)));
    return Object.fromEntries(rows.map(row => [row.stepId, structuredClone(row.output)]));
  }

  async getItemOutputs(runId: string, stepId: string): Promise<unknown[]> {
    return this.rowsOf(runId)
      .filter(row => row.stepId === stepId && row.index !== undefined)
      .sort((a, b) => a.index - b.index)
      .map(row => structuredClone(row.output));
  }

  async updateStepRun(id: string, expected: StepRunExpectation, changes: Partial<StepRun>, options: StepRunUpdateOptions = {}): Promise<StepRun | null> {
    const row = this.stepRuns.get(id);
    if (!row) return null;
    if (expected.status && !expected.status.includes(row.status)) return null;
    if (expected.fence !== undefined && expected.fence !== row.fence) return null;
    Object.assign(row, structuredClone(changes), { version: row.version + 1, fence: row.fence + (options.takeFence ? 1 : 0) });
    return structuredClone(row);
  }

  async deleteUnfinishedWork(runId: string): Promise<void> {
    for (const row of this.rowsOf(runId)) {
      if (row.status !== 'SUCCEEDED') this.stepRuns.delete(row.id);
    }
  }

  async countActiveRuns(): Promise<number> {
    return (await this.findRunning()).length;
  }

  async listPending(perRun: number): Promise<StepRun[]> {
    const pending = [...this.stepRuns.values()].filter(row => row.status === 'PENDING').sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const taken = new Map<string, number>();
    return pending
      .filter(row => {
        taken.set(row.runId, (taken.get(row.runId) ?? 0) + 1);
        return taken.get(row.runId) <= perRun;
      })
      .map(({ output, item, ...row }) => structuredClone(row));
  }

  async countInFlight(): Promise<InFlightCount[]> {
    const groups = new Map<string, InFlightCount>();
    for (const row of this.stepRuns.values()) {
      const holdsSlot = ['QUEUED', 'RUNNING'].includes(row.status) || (row.status === 'WAITING' && !row.resumed);
      if (row.fanOut || !holdsSlot) continue;
      const key = JSON.stringify([row.runId, row.stepId, row.task, row.workflow]);
      const group = groups.get(key) ?? { runId: row.runId, stepId: row.stepId, task: row.task, workflow: row.workflow, count: 0 };
      group.count++;
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  async listUnpublishedEvents(limit: number): Promise<RunEvent[]> {
    return this.events
      .filter(e => !this.published.has(`${e.runId}:${e.seq}`))
      .slice(0, limit)
      .map(e => structuredClone(e));
  }

  async markEventsPublished(events: RunEvent[]): Promise<void> {
    events.forEach(e => this.published.add(`${e.runId}:${e.seq}`));
  }

  async listDeadLetters(limit: number): Promise<StepRun[]> {
    return [...this.stepRuns.values()]
      .filter(row => row.status === 'DEAD_LETTERED')
      .slice(-limit)
      .reverse()
      .map(({ output, ...row }) => structuredClone(row));
  }

  async claimRunRequest(request: RunRequest): Promise<RunRequest> {
    if (!this.requests.has(request.key)) this.requests.set(request.key, { ...request });
    return { ...this.requests.get(request.key) };
  }

  private rowsOf(runId: string): StepRun[] {
    return [...this.stepRuns.values()].filter(row => row.runId === runId);
  }
}
