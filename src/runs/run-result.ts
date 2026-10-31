import { RunEvent, RunStatus, RunSummary, WorkflowRef } from './run.types';

export interface StepOutcome {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  output?: unknown;
  iterations?: number;
  reason?: string;
  error?: string;
}

/** A run as its caller wants to read it: status plus what each step produced */
export interface RunResult {
  runId: string;
  status: RunStatus;
  workflow?: WorkflowRef;
  failedStepId?: string;
  error?: string;
  steps: Record<string, StepOutcome>;
}

const TERMINAL: RunStatus[] = ['SUCCEEDED', 'FAILED', 'ABANDONED'];

export const isTerminal = (status: RunStatus): boolean => TERMINAL.includes(status);

/**
 * Builds a run's result from its summary and the outputs in its timeline
 */
export function toRunResult(run: RunSummary, events: RunEvent[]): RunResult {
  const outputs = new Map(events.filter(e => e.type === 'StepSucceeded').map(e => [e.data.stepId, e.data.output]));
  const steps = run.steps.map(step => {
    const outcome: StepOutcome = { status: step.status.toLowerCase() as StepOutcome['status'] };
    if (outputs.get(step.id) !== undefined) outcome.output = outputs.get(step.id);
    if (step.iterations !== undefined) outcome.iterations = step.iterations;
    if (step.reason) outcome.reason = step.reason;
    if (step.error) outcome.error = step.error;
    return [step.id, outcome];
  });
  return {
    runId: run.id,
    status: run.status,
    ...(run.workflow ? { workflow: run.workflow } : {}),
    ...(run.failedStepId ? { failedStepId: run.failedStepId } : {}),
    ...(run.error ? { error: run.error } : {}),
    steps: Object.fromEntries(steps),
  };
}
