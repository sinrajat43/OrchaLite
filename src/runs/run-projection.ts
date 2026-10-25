import { RunEvent, RunSummary, StepSummary } from './run.types';

const msBetween = (from: Date | undefined, to: Date): number | undefined =>
  from ? to.getTime() - new Date(from).getTime() : undefined;

/**
 * Applies one event to a run summary and returns the new summary.
 * Pure: the same events always give the same summary, which is what lets
 * the summary be rebuilt from the timeline at any time.
 */
export function applyEvent(summary: RunSummary | null, event: RunEvent): RunSummary {
  if (event.type === 'RunStarted') {
    const { definition } = event.data;
    return {
      id: event.runId,
      name: definition.name,
      status: 'RUNNING',
      startedAt: event.at,
      definition,
      steps: definition.steps.map((step: any) => ({ id: step.id, task: step.task, status: 'PENDING' })),
      lastSeq: event.seq,
    };
  }

  if (!summary) {
    throw new Error(`Event ${event.type} (seq ${event.seq}) for run ${event.runId} has no RunStarted before it`);
  }

  const next: RunSummary = { ...summary, steps: summary.steps.map(step => ({ ...step })), lastSeq: event.seq };
  const step = (): StepSummary => {
    const found = next.steps.find(s => s.id === event.data.stepId);
    if (!found) throw new Error(`Run ${event.runId} has no step "${event.data.stepId}"`);
    return found;
  };

  switch (event.type) {
    case 'StepStarted':
      Object.assign(step(), { status: 'RUNNING', startedAt: event.at });
      break;
    case 'StepSucceeded': {
      const s = step();
      Object.assign(s, { status: 'SUCCEEDED', endedAt: event.at, durationMs: msBetween(s.startedAt, event.at) });
      break;
    }
    case 'StepFailed': {
      const s = step();
      Object.assign(s, {
        status: 'FAILED',
        endedAt: event.at,
        durationMs: msBetween(s.startedAt, event.at),
        error: event.data.error,
      });
      break;
    }
    case 'StepSkipped':
      step().status = 'SKIPPED';
      break;
    case 'RunSucceeded':
    case 'RunFailed':
    case 'RunAbandoned':
      next.status = event.type === 'RunSucceeded' ? 'SUCCEEDED' : event.type === 'RunFailed' ? 'FAILED' : 'ABANDONED';
      next.endedAt = event.at;
      next.durationMs = msBetween(next.startedAt, event.at);
      if (event.data.failedStepId) next.failedStepId = event.data.failedStepId;
      if (event.data.error) next.error = event.data.error;
      break;
  }

  return next;
}

/**
 * Rebuilds a run summary from its full timeline
 */
export function replay(events: RunEvent[]): RunSummary | null {
  return [...events].sort((a, b) => a.seq - b.seq).reduce<RunSummary | null>(applyEvent, null);
}
