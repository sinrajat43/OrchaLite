import { RunEvent, RunStatus, RunSummary, WorkflowRef } from './run.types';

export interface StepOutcome {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'dead_lettered' | 'skipped';
  output?: unknown;
  iterations?: number;
  reason?: string;
  error?: string;
  /** Failed attempts that were retried */
  retries?: number;
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
 * Builds a run's result from its summary, the outputs in its timeline, and the
 * step rows' outputs, which are complete where the timeline only keeps a preview
 */
export function toRunResult(run: RunSummary, events: RunEvent[], rowOutputs: Record<string, unknown> = {}): RunResult {
  const outputs = new Map(events.filter(e => e.type === 'StepSucceeded').map(e => [e.data.stepId, e.data.output]));
  for (const [stepId, output] of Object.entries(rowOutputs)) {
    if (output !== undefined) outputs.set(stepId, output);
  }
  const steps = run.steps.map(step => {
    const outcome: StepOutcome = { status: step.status.toLowerCase() as StepOutcome['status'] };
    if (step.status === 'SUCCEEDED' && outputs.get(step.id) !== undefined) outcome.output = outputs.get(step.id);
    if (step.iterations !== undefined) outcome.iterations = step.iterations;
    if (step.reason) outcome.reason = step.reason;
    if (step.error) outcome.error = step.error;
    if (step.retries) outcome.retries = step.retries;
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
