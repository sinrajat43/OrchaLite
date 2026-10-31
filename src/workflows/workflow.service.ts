import { BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Response } from 'express';
import { Types } from 'mongoose';
import { EngineSignals } from '../engine/engine-signals';
import { TaskRegistry } from '../orchestrator/task-registry.service';
import { checkRun, RunInputError, validateWorkflow, WorkflowDefinition, WorkflowDefinitionError } from '../orchestrator/workflow-definition';
import { IllegalTransitionError } from '../runs/run-projection';
import { appendRunEvent } from '../runs/run-recorder';
import { isTerminal, RunResult, toRunResult } from '../runs/run-result';
import { RUN_STORE, RunStore } from '../runs/run-store';
import { RunStatus, WorkflowRef } from '../runs/run.types';

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
  /** RUNNING, unless a repeated request found a run that has already ended */
  status: RunStatus;
  workflow?: WorkflowRef;
}

// A definition can arrive as DTO class instances, which should not reach the database
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const WAIT_POLL_MS = 25;
const MAX_WAIT_MS = 60_000;

@Injectable()
export class WorkflowService {
  constructor(
    private readonly tasks: TaskRegistry,
    private readonly signals: EngineSignals,
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
   * Accepts a run: checks it and records that it started. That record is the
   * only thing the scheduler needs, so the run survives this process.
   * @param workflow - The stored version the definition came from, if any
   * @param idempotencyKey - A repeat of the same request with this key returns the first run instead of starting another
   * @throws BadRequestException if the definition or input is invalid; nothing is recorded
   * @throws ConflictException if the key was already used for a different request
   */
  async start(definition: WorkflowDefinition, runInput?: Record<string, unknown>, workflow?: WorkflowRef, idempotencyKey?: string): Promise<AcceptedRun> {
    let input: Record<string, unknown>;
    try {
      input = checkRun(definition, this.tasks, runInput);
    } catch (error) {
      throw toHttpError(error);
    }

    let runId = new Types.ObjectId().toHexString();
    if (idempotencyKey) {
      const fingerprint = createHash('sha256').update(JSON.stringify({ definition, input, workflow })).digest('hex');
      const holder = await this.runs.claimRunRequest({ key: idempotencyKey, fingerprint, runId });
      if (holder.fingerprint !== fingerprint) {
        throw new ConflictException(`Idempotency key "${idempotencyKey}" was already used for a different request`);
      }
      // A repeat falls through in case the first request died between claiming the key and recording the run
      runId = holder.runId;
      const existing = await this.runs.getRun(runId);
      if (existing) return { runId, status: existing.status, ...(workflow ? { workflow } : {}) };
    }

    try {
      await appendRunEvent(this.runs, runId, 'RunStarted', { definition: plain(definition), input, workflow, execution: 'queue' });
    } catch (error) {
      // A concurrent repeat of this request got there first, which is the same run
      if (!idempotencyKey || !(error instanceof IllegalTransitionError)) throw error;
    }
    this.signals.runChanged(runId);
    return { runId, status: 'RUNNING', ...(workflow ? { workflow } : {}) };
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
        status: result.status,
        stepId: result.failedStepId,
        task: (await this.runs.getRun(accepted.runId))?.steps.find(step => step.id === result.failedStepId)?.task,
        runId: result.runId,
      });
    }
    response.status(200);
    return result;
  }

  private async waitForResult(runId: string): Promise<RunResult | null> {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const run = await this.runs.getRun(runId);
      if (run && isTerminal(run.status)) {
        return toRunResult(run, await this.runs.getEvents(runId), await this.runs.getStepOutputs(runId));
      }
      await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
    }
    return null;
  }
}
