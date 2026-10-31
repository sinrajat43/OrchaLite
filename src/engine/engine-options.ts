/** Nest injection token for EngineOptions */
export const ENGINE_OPTIONS = Symbol('ENGINE_OPTIONS');

export const ENGINE_ROLES = ['api', 'scheduler', 'worker'] as const;
export type EngineRole = (typeof ENGINE_ROLES)[number];

export interface EngineOptions {
  /** What this process does; one process does everything by default */
  roles: EngineRole[];
  /** How long a worker holds a job without renewing; a dead worker's job returns after this */
  leaseMs: number;
  /** Steps one worker process runs at a time */
  workerSlots: number;
  /**
   * How many steps of one run may be in flight at once. Admitting work only as
   * slots free up keeps the queue short, so no run can bury the others under a
   * long backlog, whatever its size.
   */
  runWindow: number;
  /** In-flight limits by task name, across every run */
  taskLimits: Record<string, number>;
  /** Limit for one attempt of a step with no timeoutMs of its own */
  defaultStepTimeoutMs: number;
  /** How many times workers may die holding one step before it is dead-lettered */
  maxLostDeliveries: number;
  /** How often a worker looks for work when idle */
  workerPollMs: number;
  /** How often the scheduler looks over all active runs */
  schedulerIntervalMs: number;
}

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Reads "http.request=10,mongo.insert=5" */
function parseLimits(value = ''): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const entry of value.split(',').map(part => part.trim()).filter(Boolean)) {
    const [name, limit] = entry.split('=');
    if (!name || !(Number(limit) > 0)) throw new Error(`ORCHALITE_TASK_LIMITS: expected task=limit, got "${entry}"`);
    limits[name] = Number(limit);
  }
  return limits;
}

export function engineOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): EngineOptions {
  const roles = (env.ORCHALITE_ROLES ?? ENGINE_ROLES.join(',')).split(',').map(role => role.trim()).filter(Boolean);
  const unknown = roles.filter(role => !ENGINE_ROLES.includes(role as EngineRole));
  if (unknown.length) throw new Error(`ORCHALITE_ROLES: unknown role ${unknown.join(', ')}; use ${ENGINE_ROLES.join(', ')}`);
  return {
    roles: roles as EngineRole[],
    leaseMs: positive(env.ORCHALITE_LEASE_MS, 30_000),
    workerSlots: positive(env.ORCHALITE_WORKER_SLOTS, 8),
    runWindow: positive(env.ORCHALITE_RUN_WINDOW, 16),
    taskLimits: parseLimits(env.ORCHALITE_TASK_LIMITS),
    defaultStepTimeoutMs: positive(env.ORCHALITE_STEP_TIMEOUT_MS, 5 * 60_000),
    maxLostDeliveries: positive(env.ORCHALITE_MAX_LOST_DELIVERIES, 5),
    workerPollMs: positive(env.ORCHALITE_WORKER_POLL_MS, 250),
    schedulerIntervalMs: positive(env.ORCHALITE_SCHEDULER_INTERVAL_MS, 500),
  };
}
