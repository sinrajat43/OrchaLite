# OrchaLite objective and roadmap

This is the living reference for where the project is going and why. Revisit it
when starting a stage, tick items off as they land, and record decisions in the
log at the bottom. Diagrams of the current and target architecture are in
[architecture.md](architecture.md).

Last updated: 2026-10-04

## Objective

Turn OrchaLite into a small, general-purpose, durable **workflow orchestration
engine**.

- **General-purpose**: a workflow is declared as JSON and built from generic
  steps (HTTP call, transform, filter, store, notify), so new jobs are new
  definitions, not new engine code.
- **Durable**: a run is persisted as it progresses, survives process crashes,
  retries failed steps, and can be inspected, cancelled and resumed.

In the family of Temporal, Airflow, AWS Step Functions and n8n, the closest
models are Step Functions and n8n: declarative definitions rather than workflows
written as code.

## Why

The priority is **learning backend architecture in depth**. Being usable for
real jobs comes second, and matters mainly because real use cases keep the
design honest.

OrchaLite will not beat the existing tools. The value is in building each hard
part by hand and understanding why those tools are designed the way they are.

## Principles

1. **Build the concept, then consider the library.** Implement leases, retries
   and the state machine by hand first. Swap in a library (for example BullMQ)
   only behind an interface, once the hand-built version works.
2. **Every stage names what it teaches.** If a piece of work has no
   architectural lesson and no use case needs it, it waits.
3. **Prove durability with failure tests.** A stage that claims crash safety is
   done when a test kills a worker mid-run and the run still completes.
4. **Validate early.** A bad definition should be rejected at submit time, not
   fail halfway through a run.
5. **Keep the definition language small.** It is configuration with
   expressions, not a programming language.

## Where the project is today

As of 2026-10-04:

- One endpoint, `POST /workflow/run`, takes a definition and runs it inside the
  HTTP request.
- `runWorkflow` validates the graph (duplicate ids, unknown dependencies,
  cycles) and runs steps one at a time in dependency order.
- Three tasks, all GitHub-specific: `fetchRepos`, `filterRepos`, `storeRepos`.
  They are plain objects in a static registry, outside Nest's dependency
  injection.
- A step receives its dependencies' outputs positionally: one dependency gives
  the value, several give an array. `params` are static.
- Run state lives in memory. Nothing is persisted about a run, so a crash or
  client timeout loses it.
- Jest specs cover the task runner and `filterRepos`.

In short: a script runner with a DAG. It orders steps correctly but is neither
general nor durable.

## Target design

### Workflow definition

Definitions are stored once and run many times with different input. Steps
reference run input and earlier outputs by name through expressions.

```json
{
  "name": "popular-repos",
  "input": { "org": "string", "minStars": "number" },
  "steps": [
    { "id": "fetch", "task": "http.request",
      "params": { "connection": "github-main",
                  "url": "/search/repositories",
                  "query": { "q": "org:{{ input.org }}", "sort": "stars" } } },
    { "id": "popular", "task": "filter", "dependsOn": ["fetch"],
      "params": { "items": "{{ steps.fetch.output.body.items }}",
                  "where": "stargazers_count >= input.minStars" } },
    { "id": "save", "task": "mongo.insert", "dependsOn": ["popular"],
      "params": { "collection": "repos",
                  "documents": "{{ steps.popular.output }}" } }
  ]
}
```

### Task contract

A task is an injectable class that describes itself. The engine never needs to
change when a task is added.

```ts
@TaskHandler({ name: 'http.request', version: 1 })
export class HttpRequestTask implements Task<HttpParams, HttpOutput> {
  readonly paramsSchema = HttpParamsSchema;   // validated at submit time
  readonly outputSchema = HttpOutputSchema;   // lets later steps be checked

  async execute(ctx: TaskContext<HttpParams>): Promise<HttpOutput> {
    // ctx.params          resolved params, expressions already evaluated
    // ctx.signal          AbortSignal for timeout and cancellation
    // ctx.connections     named credentials, never in the definition
    // ctx.attempt         1-based attempt number
    // ctx.idempotencyKey  stable per run + step, for safe retries
    // ctx.logger          tagged with run id and step id
  }
}
```

### Runtime

The API records intent, a scheduler decides which steps are ready, and workers
execute them under a lease. See diagrams 3 and 4 in
[architecture.md](architecture.md).

## Roadmap

Two phases. Generality comes first because the task contract and wiring model
decide what a persisted step record has to store.

### Phase A: generality

- [ ] **A1. Task contract and registry**
  - Build: the `Task` interface and `TaskContext` above, a `@TaskHandler`
    decorator, discovery through Nest's `DiscoveryService`, and the three
    existing tasks ported onto it with behaviour unchanged.
  - Teaches: plugin architecture, inversion of control, the open/closed
    principle.
  - Done when: adding a task means adding one file, and no engine file changes.

- [ ] **A2. Expression-based data wiring**
  - Build: run-level `input`, `{{ ... }}` expressions over `input` and
    `steps.<id>.output`, resolved just before a step runs. Positional input is
    removed.
  - Teaches: designing a small DSL, safe evaluation without `eval`, static
    checks (an expression may only reference a step it depends on).
  - Done when: the GitHub pipeline runs with explicit wiring, and a reference
    to a non-dependency is rejected at submit time.

- [ ] **A3. Generic primitives and task catalogue**
  - Build: `http.request`, `transform`, `filter`, `mongo.insert`,
    `notify.webhook`, `delay`; a schema per task; `GET /tasks` listing names,
    versions and schemas; params validated against the schema at submit time.
  - Teaches: schema-driven validation, self-describing APIs.
  - Done when: the GitHub pipeline is expressed with primitives only and the
    three GitHub tasks are deleted.

- [ ] **A4. Stored definitions, connections and control flow**
  - Build: `POST /workflows` to store a versioned definition; named
    connections for credentials, encrypted at rest; `when` (conditional step)
    and `forEach` (fan-out over a list).
  - Teaches: definition versioning, secret handling, how control flow changes
    a static DAG into a dynamic one.
  - Done when: the release watcher or uptime alert use case runs end to end.

### Phase B: durability

- [ ] **B1. Persisted run as a state machine**
  - Build: `POST /workflows/:id/runs` returning `202` and a run id;
    `workflow_runs` and `step_runs` collections; status transitions as
    conditional updates with a version check; `GET /runs/:id`.
  - Teaches: asynchronous API design, state machines, optimistic concurrency,
    separating a definition from an execution.
  - Done when: a run's full history can be read back after the process
    restarts.

- [ ] **B2. API, scheduler and workers split**
  - Build: a scheduler that queues ready steps; workers that claim a step with
    a lease and heartbeat; requeue on lease expiry. First on MongoDB
    (`findOneAndUpdate`), then BullMQ behind the same interface.
  - Teaches: at-least-once delivery, leases and visibility timeouts, crash
    recovery, ports and adapters.
  - Done when: a test kills a worker mid-step and the run completes on another
    worker.

- [ ] **B3. Failure semantics**
  - Build: per-step retry policy with exponential backoff and jitter; timeouts
    through `AbortSignal`; retryable versus terminal errors; a dead-letter
    state; idempotency keys on the trigger API and on task side effects.
  - Teaches: why "exactly once" is at-least-once plus idempotency.
  - Done when: a step that fails twice then succeeds produces its side effect
    exactly once.

- [ ] **B4. Parallelism and backpressure**
  - Build: independent steps run concurrently; `forEach` fans out across
    workers; concurrency limits per workflow and per task; rate limiting per
    connection.
  - Teaches: bounded concurrency, fairness, backpressure.
  - Done when: a 1,000-item fan-out respects a configured limit and one large
    run cannot starve others.

- [ ] **B5. Sagas and triggers**
  - Build: compensation steps that undo earlier steps on failure; cron
    triggers guarded by a leader lock; webhook triggers with signature
    verification; a transactional outbox for run events.
  - Teaches: consistency without distributed transactions, leader election,
    reliable event publishing.
  - Done when: the webhook automation use case rolls back cleanly when its
    last step fails.

- [ ] **B6. Operability**
  - Build: structured logs with run and step correlation ids; OpenTelemetry
    traces with one span per step; metrics for queue depth, step latency and
    retry rate; graceful shutdown that drains in-flight steps; endpoints to
    cancel a run and retry from the failed step.
  - Teaches: what it takes to run and debug a distributed system in
    production.
  - Done when: a failed run can be diagnosed from telemetry alone, without
    reading the database by hand.

## Target use cases

These are the yardsticks. A stage is worth doing if it moves one of them
closer.

| Use case | Steps | First possible after |
| --- | --- | --- |
| Popular repos snapshot | search GitHub, filter by stars, store | A3 |
| API-to-API sync | fetch from A, reshape, POST to B | A3 |
| **Release watcher** (near-term target) | fetch latest releases, compare with stored version, notify on change | A4 |
| **Uptime alert** (near-term target) | call endpoints, and when one is down, notify | A4 |
| Multi-org report | for each org, run the fetch and filter chain, combine | A4 |
| Daily digest on a schedule | cron trigger, fetch, summarise, post | B5 |
| **Webhook automation with rollback** (durable target) | receive event, enrich, act on two systems, undo the first if the second fails | B5 |
| Long waits | send, wait three days, follow up | B2 (durable `delay`) |

## Out of scope for now

- **Arbitrary user code** (a `script` task). It needs sandboxing, which is a
  project of its own.
- **Tasks in other languages or processes.** It needs a worker protocol over
  the network.
- **A visual editor or UI.** `GET /tasks` and the run endpoints are designed so
  one could be added later.
- **Multi-tenancy and authentication.** Single user, trusted network.

## Open decisions

| Decision | Options | Leaning |
| --- | --- | --- |
| Expression language (needed for A2) | JSONata, JMESPath | JSONata: it reshapes data as well as querying it, so it also covers the `transform` task |
| Schema library (needed for A1) | Zod, JSON Schema with Ajv, class-validator | Open. JSON Schema serialises cleanly for `GET /tasks`; Zod is nicer to write |
| Where large step outputs live (needed for B1) | inline in `step_runs`, separate collection, object storage | Open |

## Decision log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-10-04 | Objective set: general-purpose, durable workflow orchestration engine; architecture learning is the priority | See "Why" |
| 2026-10-04 | Declarative JSON definitions, not workflows as code | Smaller surface, validates at submit time, closest to the existing design |
| 2026-10-04 | Generality (phase A) before durability (phase B) | The task contract and wiring model decide what a persisted step record stores |
| 2026-10-04 | Use an existing expression language, not a custom one or `eval` | Safety, and the lesson is in integrating a DSL, not writing a parser |
