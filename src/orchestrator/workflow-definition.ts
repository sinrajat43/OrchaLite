import { ValidateFunction } from 'ajv';
import { compileTemplate, findReferences, Template } from '../expressions/template';
import { ajv, formatSchemaErrors, validatorFor } from './schema-validator';
import { Task } from '../tasks/task.interface';
import { TaskLookup } from './task-registry.service';

/** A JSON Schema type name, or a full JSON Schema for the value */
export type InputDeclaration = string | Record<string, unknown>;

export interface WorkflowStep {
  id: string;
  task: string;
  /** May contain {{ ... }} expressions over input and steps.<id>.output */
  params?: Record<string, unknown>;
  dependsOn: string[];
  /** {{ ... }} condition; when false the step and everything downstream of it is skipped */
  when?: string;
  /** {{ ... }} list; the step runs once per item, and its params can read item and index */
  forEach?: string;
  /** How often to try a step that fails with a retryable error; once by default */
  retry?: RetryPolicy;
  /** Limit for one attempt; a task that outlasts it is aborted and the attempt fails */
  timeoutMs?: number;
  /** forEach steps: how many items may be in flight at once */
  concurrency?: number;
  /** What undoes this step if a later step fails; can read this step's own output */
  compensate?: Compensation;
}

export interface Compensation {
  task: string;
  params?: Record<string, unknown>;
  /** A rollback should try hard: 5 attempts by default */
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export interface RetryPolicy {
  /** Tries in total, including the first */
  maxAttempts: number;
  /** Wait before the second try; doubles (by multiplier) after each failure. 1000 by default */
  backoffMs?: number;
  multiplier?: number;
  /** The longest wait between tries. 5 minutes by default */
  maxBackoffMs?: number;
}

export interface WorkflowDefinition {
  name: string;
  /** Values a run must supply, by name */
  input?: Record<string, InputDeclaration>;
  /** How many steps may be in flight at once, across all runs of this workflow */
  concurrency?: number;
  steps: WorkflowStep[];
}

export interface CompiledStep {
  step: WorkflowStep;
  params: Template;
  when?: Template;
  forEach?: Template;
  /** Every step this one depends on, directly or not */
  upstream: Set<string>;
  compensate?: { task: string; params: Template };
}

export interface CompiledWorkflow {
  definition: WorkflowDefinition;
  steps: CompiledStep[];
  /** Validates run input and fills in defaults */
  validateInput: ValidateFunction;
}

const validateRetry = validatorFor({
  type: 'object',
  properties: {
    maxAttempts: { type: 'integer', minimum: 1, maximum: 100 },
    backoffMs: { type: 'integer', minimum: 0 },
    multiplier: { type: 'number', minimum: 1, maximum: 10 },
    maxBackoffMs: { type: 'integer', minimum: 0 },
  },
  required: ['maxAttempts'],
  additionalProperties: false,
} as any);

const INPUT_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];

/**
 * Error thrown when a workflow definition is invalid
 */
export class WorkflowDefinitionError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid workflow definition: ${issues.join('; ')}`);
    this.name = 'WorkflowDefinitionError';
  }
}

/**
 * Error thrown when run input does not match the definition's declared input
 */
export class RunInputError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid run input: ${issues.join('; ')}`);
    this.name = 'RunInputError';
  }
}

function checkGraph(steps: WorkflowStep[], issues: string[]): void {
  const ids = new Set<string>();

  for (const step of steps) {
    if (ids.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}"`);
    }
    ids.add(step.id);
  }

  for (const step of steps) {
    for (const depId of step.dependsOn) {
      if (!ids.has(depId)) {
        issues.push(`Step "${step.id}" depends on unknown step "${depId}"`);
      }
    }
  }
  if (issues.length > 0) return;

  // Repeatedly resolve steps whose dependencies are resolved; leftovers are in a cycle
  const resolved = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const step of steps) {
      if (!resolved.has(step.id) && step.dependsOn.every(dep => resolved.has(dep))) {
        resolved.add(step.id);
        progressed = true;
      }
    }
  }

  const unresolved = steps.filter(s => !resolved.has(s.id)).map(s => s.id);
  if (unresolved.length > 0) {
    issues.push(`Circular dependency involving steps: ${unresolved.join(', ')}`);
  }
}

function compileInput(input: WorkflowDefinition['input'], issues: string[]): ValidateFunction | undefined {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, declaration] of Object.entries(input ?? {})) {
    if (typeof declaration === 'string') {
      if (!INPUT_TYPES.includes(declaration)) {
        issues.push(`input.${name}: unknown type "${declaration}"; use one of ${INPUT_TYPES.join(', ')} or a JSON Schema`);
        continue;
      }
      properties[name] = { type: declaration };
      required.push(name);
    } else {
      properties[name] = declaration;
      if (!('default' in declaration)) required.push(name);
    }
  }

  try {
    return ajv.compile({ type: 'object', properties, required, additionalProperties: false });
  } catch (error) {
    issues.push(`input: invalid schema: ${(error as Error).message}`);
    return undefined;
  }
}

/** All steps reachable through dependsOn; safe on cyclic graphs */
function upstreamOf(id: string, byId: Map<string, WorkflowStep>): Set<string> {
  const seen = new Set<string>();
  const pending = [...(byId.get(id)?.dependsOn ?? [])];
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(byId.get(next)?.dependsOn ?? []));
  }
  seen.delete(id);
  return seen;
}

/**
 * Validates params as written against the task's schema. A value holding an
 * expression is only known at run time, so errors at or below it are dropped;
 * the resolved params are validated again before the task runs.
 */
function checkParams(task: Task, raw: Record<string, unknown>, expressionPointers: string[]): string[] {
  const validate = validatorFor(task.paramsSchema);
  const unknownAt = (pointer: string) => expressionPointers.some(p => pointer === p || pointer.startsWith(`${p}/`));

  // Validation fills in defaults, so check a copy
  validate(structuredClone(raw));
  const schemaIssues = formatSchemaErrors(
    (validate.errors ?? []).filter(error => !unknownAt(error.instancePath)),
    'params'
  );
  return [...schemaIssues, ...(task.validate?.(raw) ?? [])];
}

/**
 * Checks a definition and compiles its expressions. Every problem is reported
 * at once, so a bad definition is rejected before any step runs.
 * @throws WorkflowDefinitionError listing every issue found
 */
export function validateWorkflow(definition: WorkflowDefinition, tasks: TaskLookup): CompiledWorkflow {
  const issues: string[] = [];
  const steps = definition.steps;
  const byId = new Map(steps.map(step => [step.id, step]));

  checkGraph(steps, issues);
  const validateInput = compileInput(definition.input, issues);
  const declaredInputs = new Set(Object.keys(definition.input ?? {}));

  const compiled = steps.map(step => {
    const where = `Step "${step.id}"`;
    const task = tasks.get(step.task);
    if (!task) {
      issues.push(`${where} uses unknown task "${step.task}"`);
    }

    const upstream = upstreamOf(step.id, byId);
    const params = compileTemplate(step.params ?? {}, 'params');
    issues.push(...params.issues.map(issue => `${where} ${issue}`));

    if (task && params.issues.length === 0) {
      issues.push(...checkParams(task, step.params ?? {}, params.expressions.map(e => e.pointer)).map(issue => `${where} ${issue}`));
    }

    if (step.concurrency !== undefined && step.forEach === undefined) {
      issues.push(`${where} concurrency only applies to a forEach step`);
    }
    if (step.retry !== undefined && !validateRetry(structuredClone(step.retry))) {
      issues.push(...formatSchemaErrors(validateRetry.errors, 'retry').map(issue => `${where} ${issue}`));
    }

    // when and forEach are each a single expression, evaluated once before the step runs
    const control = (['when', 'forEach'] as const).map(field => {
      if (step[field] === undefined) return undefined;
      const compiled = compileTemplate(step[field], field);
      issues.push(...compiled.issues.map(issue => `${where} ${issue}`));
      if (compiled.issues.length === 0 && compiled.template.kind !== 'expression') {
        issues.push(`${where} ${field} must be a single {{ ... }} expression`);
      }
      return compiled;
    });

    // Only a forEach step's params can read the current item
    const located = [
      ...params.expressions.map(e => ({ ...e, rootNames: step.forEach !== undefined ? ['item', 'index'] : [] })),
      ...control.flatMap(c => c?.expressions ?? []).map(e => ({ ...e, rootNames: [] as string[] })),
    ];

    // Undoing a step runs after it, so it can read that step's output too
    let compensate: CompiledStep['compensate'];
    const compensationReads = new Set<string>();
    if (step.compensate) {
      const { task: undoName, params: undoParams = {}, retry } = step.compensate;
      if (step.forEach !== undefined) issues.push(`${where} compensate cannot be combined with forEach`);
      if (retry !== undefined && !validateRetry(structuredClone(retry))) {
        issues.push(...formatSchemaErrors(validateRetry.errors, 'compensate.retry').map(issue => `${where} ${issue}`));
      }
      const undoTask = tasks.get(undoName);
      if (!undoTask) issues.push(`${where} compensate uses unknown task "${undoName}"`);
      const undo = compileTemplate(undoParams, 'compensate.params');
      issues.push(...undo.issues.map(issue => `${where} ${issue}`));
      if (undoTask && undo.issues.length === 0) {
        issues.push(...checkParams(undoTask, undoParams, undo.expressions.map(e => e.pointer)).map(issue => `${where} compensate ${issue}`));
      }
      located.push(...undo.expressions.map(e => ({ ...e, rootNames: [] as string[] })));
      undo.expressions.forEach(e => compensationReads.add(e.path));
      compensate = { task: undoName, params: undo.template };
    }

    for (const { expr, path, rootNames } of located) {
      const refs = findReferences(expr, path, rootNames);
      issues.push(...refs.issues.map(issue => `${where} ${issue}`));
      for (const id of refs.steps) {
        if (!byId.has(id)) issues.push(`${where} ${path} references unknown step "${id}"`);
        else if (!upstream.has(id) && !(id === step.id && compensationReads.has(path))) {
          issues.push(`${where} ${path} references step "${id}", which it does not depend on`);
        }
      }
      for (const name of refs.inputs) {
        if (!declaredInputs.has(name)) issues.push(`${where} ${path} references undeclared input "${name}"`);
      }
    }

    return { step, params: params.template, when: control[0]?.template, forEach: control[1]?.template, upstream, compensate };
  });

  if (issues.length > 0) {
    throw new WorkflowDefinitionError(issues);
  }
  return { definition, steps: compiled, validateInput };
}

/**
 * The checks a run must pass before it is accepted
 * @returns the input, on a copy, with defaults filled in
 * @throws WorkflowDefinitionError if the definition is invalid
 * @throws RunInputError if the input does not match the declared input
 */
export function checkRun(definition: WorkflowDefinition, tasks: TaskLookup, runInput?: Record<string, unknown>): Record<string, unknown> {
  const compiled = validateWorkflow(definition, tasks);
  const input = structuredClone(runInput ?? {});
  if (!compiled.validateInput(input)) {
    throw new RunInputError(formatSchemaErrors(compiled.validateInput.errors, 'input'));
  }
  return input;
}
