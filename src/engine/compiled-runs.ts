import { TaskLookup } from '../orchestrator/task-registry.service';
import { CompiledStep, validateWorkflow, WorkflowDefinition } from '../orchestrator/workflow-definition';
import { RunSummary } from '../runs/run.types';

const MAX_CACHED = 500;

/**
 * Compiled definitions by run id. A run's definition never changes, so
 * compiling once per process is enough.
 */
export class CompiledRuns {
  private readonly cache = new Map<string, Map<string, CompiledStep>>();

  constructor(private readonly tasks: TaskLookup) {}

  /** @throws WorkflowDefinitionError if the definition no longer compiles, e.g. a task was removed */
  steps(run: Pick<RunSummary, 'id' | 'definition'>): Map<string, CompiledStep> {
    const cached = this.cache.get(run.id);
    if (cached) return cached;
    const compiled = validateWorkflow(run.definition as WorkflowDefinition, this.tasks);
    const steps = new Map(compiled.steps.map(step => [step.step.id, step]));
    if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(run.id, steps);
    return steps;
  }
}
