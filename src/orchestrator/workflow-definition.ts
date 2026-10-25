import { ValidateFunction } from 'ajv';
import { compileTemplate, findReferences, Template } from '../expressions/template';
import { ajv } from './schema-validator';
import { TaskLookup } from './task-registry.service';

/** A JSON Schema type name, or a full JSON Schema for the value */
export type InputDeclaration = string | Record<string, unknown>;

export interface WorkflowStep {
  id: string;
  task: string;
  /** May contain {{ ... }} expressions over input and steps.<id>.output */
  params?: Record<string, unknown>;
  dependsOn: string[];
}

export interface WorkflowDefinition {
  name: string;
  /** Values a run must supply, by name */
  input?: Record<string, InputDeclaration>;
  steps: WorkflowStep[];
}

export interface CompiledStep {
  step: WorkflowStep;
  params: Template;
  /** Every step this one depends on, directly or not */
  upstream: Set<string>;
}

export interface CompiledWorkflow {
  definition: WorkflowDefinition;
  steps: CompiledStep[];
  /** Validates run input and fills in defaults */
  validateInput: ValidateFunction;
}

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
    if (!tasks.get(step.task)) {
      issues.push(`${where} uses unknown task "${step.task}"`);
    }

    const upstream = upstreamOf(step.id, byId);
    const params = compileTemplate(step.params ?? {}, 'params');
    issues.push(...params.issues.map(issue => `${where} ${issue}`));

    for (const { expr, path } of params.expressions) {
      const refs = findReferences(expr, path);
      issues.push(...refs.issues.map(issue => `${where} ${issue}`));
      for (const id of refs.steps) {
        if (!byId.has(id)) issues.push(`${where} ${path} references unknown step "${id}"`);
        else if (!upstream.has(id)) issues.push(`${where} ${path} references step "${id}", which it does not depend on`);
      }
      for (const name of refs.inputs) {
        if (!declaredInputs.has(name)) issues.push(`${where} ${path} references undeclared input "${name}"`);
      }
    }

    return { step, params: params.template, upstream };
  });

  if (issues.length > 0) {
    throw new WorkflowDefinitionError(issues);
  }
  return { definition, steps: compiled, validateInput };
}
