import { BadRequestException, BeforeApplicationShutdown, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { Response } from 'express';
import { ConnectionsService } from '../connections/connections.service';
import { checkRun, runWorkflow, RunInputError } from '../orchestrator/task-runner.util';
import { TaskRegistry } from '../orchestrator/task-registry.service';
import { validateWorkflow, WorkflowDefinition, WorkflowDefinitionError } from '../orchestrator/workflow-definition';
import { RunHandle, RunRecorder } from '../runs/run-recorder';
import { isTerminal, RunResult, toRunResult } from '../runs/run-result';
import { RUN_STORE, RunStore } from '../runs/run-store';
import { WorkflowRef } from '../runs/run.types';

/**
 * Maps engine errors to HTTP errors
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof WorkflowDefinitionError) {
    return new BadRequestException({ message: 'Invalid workflow definition', errors: error.issues });
  }
  if (error instanceof RunInputError) {
    return new BadRequestException({ message: 'Invalid run input', errors: error.issues });
  }
  return error;
}

/** What accepting a run returns, before any step has run */
export interface AcceptedRun {
  runId: string;
  status: 'RUNNING';
  workflow?: WorkflowRef;
}

const WAIT_POLL_MS = 25;
const MAX_WAIT_MS = 60_000;

@Injectable()
export class WorkflowService implements BeforeApplicationShutdown {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly tasks: TaskRegistry,
    private readonly connections: ConnectionsService,
    private readonly runRecorder: RunRecorder,
    @Inject(RUN_STORE) private readonly runs: RunStore
  ) {}

  /**
   * @throws BadRequestException listing every problem with the definition
   */
  validate(definition: WorkflowDefinition): void {
    try {
      validateWorkflow(definition, this.tasks);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  /**
   * Accepts a run: checks it, records that it started, and runs it in the
   * background, so the caller gets a run id without waiting for any step.
   * @param workflow - The stored version the definition came from, if any
   * @throws BadRequestException if the definition or input is invalid; nothing is recorded
   */
  async start(definition: WorkflowDefinition, runInput?: Record<string, unknown>, workflow?: WorkflowRef): Promise<AcceptedRun> {
    let input: Record<string, unknown>;
    try {
      ({ input } = checkRun(definition, this.tasks, runInput));
    } catch (error) {
      throw toHttpError(error);
    }

    const run = this.runRecorder.prepare(definition, workflow);
    await run.hooks.onRunStarted(input);
    const finished = this.execute(run, definition, input).finally(() => this.inFlight.delete(finished));
    this.inFlight.add(finished);
    return { runId: run.runId, status: 'RUNNING', ...(workflow ? { workflow } : {}) };
  }

  /**
   * What a run request responds with. By default that is the accepted run (202);
   * with wait=true the request stays open until the run ends, then returns its
   * result (200) or the failed step (500). It only reads the run's state, and a
   * run that outlasts the wait is reported as still accepted.
   */
  async respond(accepted: AcceptedRun, wait: string | undefined, response: Response): Promise<AcceptedRun | RunResult> {
    if (wait !== 'true') return accepted;
    const result = await this.waitForResult(accepted.runId);
    if (!result) return accepted;
    if (result.status !== 'SUCCEEDED') {
      throw new InternalServerErrorException({
        message: result.error,
        stepId: result.failedStepId,
        task: (await this.runs.getRun(accepted.runId))?.steps.find(step => step.id === result.failedStepId)?.task,
        runId: result.runId,
      });
    }
    response.status(200);
    return result;
  }

  /** Waits for in-flight runs, so their last events are written before the database closes */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.inFlight);
  }

  private async waitForResult(runId: string): Promise<RunResult | null> {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const run = await this.runs.getRun(runId);
      if (run && isTerminal(run.status)) return toRunResult(run, await this.runs.getEvents(runId));
      await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
    }
    return null;
  }

  private async execute(run: RunHandle, definition: WorkflowDefinition, input: Record<string, unknown>): Promise<void> {
    try {
      console.log(`Starting workflow: ${definition.name} (run ${run.runId})`);
      await runWorkflow(definition, this.tasks, {
        input,
        connections: this.connections,
        runId: run.runId,
        // onRunStarted already fired when the run was accepted
        hooks: { ...run.hooks, onRunStarted: undefined },
      });
      await run.succeed();
      console.log(`Completed workflow: ${definition.name} (run ${run.runId})`);
    } catch (error) {
      console.error('Workflow execution failed:', error);
      await run.fail(error as Error);
    }
  }
}
