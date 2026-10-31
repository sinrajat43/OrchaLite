import { RunEvent, RunEventType, RunStatus, RunSummary, StepStatus, StepSummary } from './run.types';

/** Which status an event may move a run from; anything else is a bug or a stale writer */
const RUN_TRANSITIONS: Partial<Record<RunEventType, RunStatus[]>> = {
  RunSucceeded: ['RUNNING'],
  RunFailed: ['RUNNING'],
  RunAbandoned: ['RUNNING'],
  RunCompensating: ['RUNNING'],
  RunCompensated: ['COMPENSATING'],
  RunCompensationFailed: ['COMPENSATING'],
  RunCancelling: ['RUNNING'],
  RunCancelled: ['CANCELLING'],
  RunRetried: ['FAILED', 'CANCELLED'],
};

/** Which status an event may move a step from */
const STEP_TRANSITIONS: Partial<Record<RunEventType, StepStatus[]>> = {
  StepStarted: ['PENDING'],
  StepSucceeded: ['RUNNING'],
  StepFailed: ['RUNNING'],
  StepSkipped: ['PENDING', 'RUNNING'],
  StepCancelled: ['RUNNING'],
};

const RUN_ENDINGS: Partial<Record<RunEventType, RunStatus>> = {
  RunSucceeded: 'SUCCEEDED',
  RunFailed: 'FAILED',
  RunAbandoned: 'ABANDONED',
  RunCompensated: 'COMPENSATED',
  RunCompensationFailed: 'COMPENSATION_FAILED',
  RunCancelled: 'CANCELLED',
};

/**
 * An event that the run's state machine does not allow from its current state
 */
export class IllegalTransitionError extends Error {
  constructor(event: RunEvent, from: string) {
    super(`Run ${event.runId}: ${event.type} is not allowed from ${from}`);
    this.name = 'IllegalTransitionError';
  }
}

const msBetween = (from: Date | undefined, to: Date): number | undefined =>
  from ? to.getTime() - new Date(from).getTime() : undefined;

/**
 * Applies one event to a run summary and returns the new summary.
 * Pure: the same events always give the same summary, which is what lets
 * the summary be rebuilt from the timeline at any time.
 */
export function applyEvent(summary: RunSummary | null, event: RunEvent): RunSummary {
  if (event.type === 'RunStarted') {
    if (summary) throw new IllegalTransitionError(event, summary.status);
    const { definition, input, workflow, execution } = event.data;
    return {
      id: event.runId,
      name: definition.name,
      status: 'RUNNING',
      startedAt: event.at,
      definition,
      ...(input ? { input } : {}),
      ...(workflow ? { workflow } : {}),
      ...(execution ? { execution } : {}),
      steps: definition.steps.map((step: any) => ({ id: step.id, task: step.task, status: 'PENDING' })),
      lastSeq: event.seq,
    };
  }

  if (!summary) {
    throw new Error(`Event ${event.type} (seq ${event.seq}) for run ${event.runId} has no RunStarted before it`);
  }

  const allowedFrom = RUN_TRANSITIONS[event.type];
  if (allowedFrom && !allowedFrom.includes(summary.status)) {
    throw new IllegalTransitionError(event, summary.status);
  }

  const next: RunSummary = { ...summary, steps: summary.steps.map(step => ({ ...step })), lastSeq: event.seq };
  const step = (): StepSummary => {
    const found = next.steps.find(s => s.id === event.data.stepId);
    if (!found) throw new Error(`Run ${event.runId} has no step "${event.data.stepId}"`);
    if (!STEP_TRANSITIONS[event.type].includes(found.status)) {
      throw new IllegalTransitionError(event, `step "${found.id}" ${found.status}`);
    }
    return found;
  };

  // Only informs: a retry can be reported before or after the step's other events
  if (event.type === 'StepRetryScheduled') {
    const retried = next.steps.find(s => s.id === event.data.stepId);
    if (retried) retried.retries = (retried.retries ?? 0) + 1;
    return next;
  }

  if (event.type === 'CompensationStarted' || event.type === 'CompensationSucceeded' || event.type === 'CompensationFailed') {
    const undone = next.steps.find(s => s.id === event.data.stepId);
    if (!undone) throw new Error(`Run ${event.runId} has no step "${event.data.stepId}"`);
    undone.compensation = event.type === 'CompensationStarted' ? 'RUNNING' : event.type === 'CompensationSucceeded' ? 'SUCCEEDED' : 'FAILED';
    if (event.data.error) undone.compensationError = event.data.error;
    return next;
  }

  if (event.type === 'RunCancelling') {
    next.status = 'CANCELLING';
    return next;
  }

  // Back to work: what succeeded stands, and everything else gets another go
  if (event.type === 'RunRetried') {
    next.status = 'RUNNING';
    for (const field of ['endedAt', 'durationMs', 'failedStepId', 'error'] as const) delete next[field];
    next.steps = next.steps.map(step => (step.status === 'SUCCEEDED' ? step : { id: step.id, task: step.task, status: 'PENDING' }));
    return next;
  }

  // The run failed, and steps are being undone: it keeps why, and ends only once that is over
  if (event.type === 'RunCompensating') {
    next.status = 'COMPENSATING';
    next.failedStepId = event.data.failedStepId;
    next.error = event.data.error;
    return next;
  }

  switch (event.type) {
    case 'StepStarted':
      Object.assign(step(), { status: 'RUNNING', startedAt: event.at });
      break;
    case 'StepSucceeded': {
      const s = step();
      Object.assign(s, { status: 'SUCCEEDED', endedAt: event.at, durationMs: msBetween(s.startedAt, event.at) });
      if (event.data.iterations !== undefined) s.iterations = event.data.iterations;
      break;
    }
    case 'StepFailed': {
      const s = step();
      Object.assign(s, {
        status: event.data.deadLettered ? 'DEAD_LETTERED' : 'FAILED',
        endedAt: event.at,
        durationMs: msBetween(s.startedAt, event.at),
        error: event.data.error,
      });
      break;
    }
    case 'StepSkipped': {
      const s = step();
      s.status = 'SKIPPED';
      if (event.data.reason) s.reason = event.data.reason;
      if (s.startedAt) Object.assign(s, { endedAt: event.at, durationMs: msBetween(s.startedAt, event.at) });
      break;
    }
    case 'StepCancelled': {
      const s = step();
      Object.assign(s, { status: 'CANCELLED', endedAt: event.at, durationMs: msBetween(s.startedAt, event.at) });
      break;
    }
    case 'RunSucceeded':
    case 'RunFailed':
    case 'RunCancelled':
    case 'RunAbandoned':
    case 'RunCompensated':
    case 'RunCompensationFailed':
      next.status = RUN_ENDINGS[event.type];
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
