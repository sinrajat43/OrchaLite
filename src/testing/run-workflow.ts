import { Types } from 'mongoose';
import { EngineSignals } from '../engine/engine-signals';
import { InMemoryStepQueue } from '../engine/in-memory-step-queue';
import { Scheduler } from '../engine/scheduler';
import { Worker } from '../engine/worker';
import { TaskLookup } from '../orchestrator/task-registry.service';
import { checkRun, WorkflowDefinition } from '../orchestrator/workflow-definition';
import { InMemoryRunStore } from '../runs/in-memory-run-store';
import { appendRunEvent } from '../runs/run-recorder';
import { isTerminal, RunResult, toRunResult } from '../runs/run-result';
import { ConnectionLookup, TaskExecutionError, TaskLogger } from '../tasks/task.interface';
import { silentLogger } from './task-context';

export interface RunOptions {
  input?: Record<string, unknown>;
  connections?: ConnectionLookup;
  runId?: string;
  createLogger?: (context: string) => TaskLogger;
  /** Pass one to look at the run's history afterwards */
  store?: InMemoryRunStore;
  workerSlots?: number;
}

const noConnections: ConnectionLookup = {
  get: async name => {
    throw new Error(`Connection "${name}" is not available: no connections are configured`);
  },
};

/**
 * Runs a workflow to the end on the real scheduler and worker, with everything
 * in memory
 * @throws WorkflowDefinitionError or RunInputError if the run is rejected
 * @throws TaskExecutionError if a step fails
 */
export async function runWorkflow(definition: WorkflowDefinition, tasks: TaskLookup, options: RunOptions = {}): Promise<RunResult> {
  const input = checkRun(definition, tasks, options.input);
  const store = options.store ?? new InMemoryRunStore();
  const queue = new InMemoryStepQueue();
  const signals = new EngineSignals();
  const runId = options.runId ?? new Types.ObjectId().toHexString();

  const scheduler = new Scheduler({ store, queue, tasks, signals, options: { schedulerIntervalMs: 5 } });
  const worker = new Worker({
    store,
    queue,
    tasks,
    signals,
    connections: options.connections ?? noConnections,
    createLogger: options.createLogger ?? (() => silentLogger),
    options: { leaseMs: 5000, workerSlots: options.workerSlots ?? 1, workerPollMs: 2 },
  });
  scheduler.start();
  worker.start();

  try {
    await appendRunEvent(store, runId, 'RunStarted', { definition, input, execution: 'queue' });
    signals.runChanged(runId);
    let run = await store.getRun(runId);
    while (!isTerminal(run.status)) {
      await new Promise(resolve => setTimeout(resolve, 2));
      run = await store.getRun(runId);
    }
    if (run.status !== 'SUCCEEDED') {
      const task = run.steps.find(step => step.id === run.failedStepId)?.task;
      throw new TaskExecutionError(run.failedStepId, task, run.error);
    }
    return toRunResult(run, await store.getEvents(runId), await store.getStepOutputs(runId));
  } finally {
    await worker.stop();
    await scheduler.stop();
  }
}

