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
  /** How often a worker looks for work when idle */
  workerPollMs: number;
  /** How often the scheduler looks over all active runs */
  schedulerIntervalMs: number;
}

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function engineOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): EngineOptions {
  const roles = (env.ORCHALITE_ROLES ?? ENGINE_ROLES.join(',')).split(',').map(role => role.trim()).filter(Boolean);
  const unknown = roles.filter(role => !ENGINE_ROLES.includes(role as EngineRole));
  if (unknown.length) throw new Error(`ORCHALITE_ROLES: unknown role ${unknown.join(', ')}; use ${ENGINE_ROLES.join(', ')}`);
  return {
    roles: roles as EngineRole[],
    leaseMs: positive(env.ORCHALITE_LEASE_MS, 30_000),
    workerSlots: positive(env.ORCHALITE_WORKER_SLOTS, 1),
    workerPollMs: positive(env.ORCHALITE_WORKER_POLL_MS, 250),
    schedulerIntervalMs: positive(env.ORCHALITE_SCHEDULER_INTERVAL_MS, 500),
  };
}
