# OrchaLite architecture

> Sections 1 and 2 describe the system before phase B. Phase B built the target in
> sections 3 and 4; [engine-design.md](engine-design.md) describes it as built.

Four diagrams: what the code does today (1, 2), and where the roadmap takes it (3, 4).

## 1. Today: one request runs the whole workflow

As of the end of phase A (generality), plus run history. A definition is
validated and compiled up front, then run inside the HTTP request. Each step
is reported to a recorder that appends it to the run's history (see
[run-history-design.md](run-history-design.md)), but the run itself lives in
one process: a crash or client timeout ends it, and it is marked `ABANDONED`
on the next start rather than resumed.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as WorkflowController / DefinitionsController
    participant Store as DefinitionStore
    participant Run as runWorkflow
    participant Reg as TaskRegistry
    participant Conn as ConnectionsService
    participant T as Task (http.request, filter, ...)

    alt ad hoc
        C->>API: POST /workflow/run { definition, input }
    else stored
        C->>API: POST /workflows/:name/runs { input, version? }
        API->>Store: get(name, version)
    end
    API->>Run: runWorkflow(definition, registry, { input, connections })
    Run->>Run: validateWorkflow: DAG, tasks, input schema,<br/>expressions and their references, params schemas
    Run->>Run: validate input, fill defaults

    loop one step at a time, in dependency order
        Run->>Run: skip if a dependency was skipped, or when is false
        Run->>Run: resolve forEach (once) and params (per item)<br/>with JSONata over input and upstream outputs
        Run->>Run: validate resolved params against paramsSchema
        Run->>Reg: get(task name), latest version
        Run->>T: execute(ctx: params, signal, attempt, idempotencyKey, logger, connections)
        opt step names a connection
            T->>Conn: get(name), decrypted, only sent under its baseUrl
        end
        T-->>Run: output
    end

    Run-->>API: { runId, steps: { id: { status, output } } }
    API-->>C: 201 with every step's result
```

## 2. Today: modules and where the weak points are

```mermaid
flowchart TB
    Client([Client / web UI])

    subgraph Nest["NestJS process (single)"]
        direction TB
        App["AppModule<br/>MongoDB connection"]
        subgraph Api["ApiModule"]
            Wf["WorkflowModule<br/>POST /workflow/run, GET /tasks"]
            Defs["DefinitionsModule<br/>/workflows: versioned, immutable"]
            Conns["ConnectionsModule<br/>/connections: AES-256-GCM at rest"]
            Inbox["InboxModule<br/>/inbox: local webhook target"]
            RunsM["RunsModule<br/>/runs: history, RunRecorder"]
        end
        Orch["OrchestratorModule<br/>TaskRegistry via DiscoveryService"]
        Engine["validateWorkflow + runWorkflow<br/>expressions, when, forEach"]
        Results[("step results<br/>in memory only")]
        Tasks["TasksModule<br/>@TaskHandler classes"]
    end

    Mongo[(MongoDB<br/>workflow_definitions, connections,<br/>run_events, workflow_runs,<br/>task collections)]
    Ext[(External APIs)]

    Client -->|HTTP, waits for the full run| Api
    App --> Api
    Wf --> Engine
    Defs --> Wf
    Engine --> Orch
    Orch -.->|discovered at startup| Tasks
    Engine -->|reads and writes step outputs| Results
    Engine -->|hooks: each step's outcome| RunsM
    RunsM --> Mongo
    Tasks --> Ext
    Tasks --> Mongo
    Defs --> Mongo
    Conns --> Mongo

    classDef weak stroke:#d9480f,stroke-width:2px,stroke-dasharray:5 3;
    class Results,Engine weak;
```

Dashed orange marks the weak points, which phase B addresses:

| Where | Problem |
| --- | --- |
| step results | Execution state lives in memory. History is recorded as the run goes, so a run can be inspected afterwards, but a crash or client timeout ends it and it cannot be resumed (B1, B2). |
| `runWorkflow` | Runs inside the request, one step and one `forEach` item at a time (B2, B4). No retries or timeouts: the abort signal is never fired and `attempt` is always 1 (B3). The first failure discards the outputs of steps that already succeeded (B1). |
| `delay` | Holds the request open, so it is capped at 60 seconds (B2). |

## 3. Target: durable engine with API, scheduler and workers split

The API only records intent. The scheduler decides what is ready. Workers do the
work and can die at any point without losing the run.

```mermaid
flowchart LR
    Client([Client])
    Cron([Cron / webhook triggers])

    subgraph API["API service"]
        Defs["Definitions API<br/>validate DAG, version"]
        Runs["Runs API<br/>start, status, cancel, retry"]
    end

    subgraph Store["MongoDB"]
        DefCol[("workflow_definitions")]
        RunCol[("workflow_runs")]
        StepCol[("step_runs<br/>status, attempt, lease, output ref")]
        Outbox[("outbox events")]
    end

    Sched["Scheduler<br/>finds steps whose deps succeeded,<br/>requeues expired leases"]
    Queue[["Queue<br/>Mongo lease first, BullMQ later"]]

    subgraph Workers["Workers (N processes)"]
        W["Worker<br/>claim, heartbeat, execute,<br/>retry with backoff, timeout"]
        TaskReg["Task registry<br/>injectable, schema per task"]
    end

    Ext[(External APIs)]
    Obs["Logs, traces, metrics<br/>keyed by run id and step id"]

    Client -->|"POST /workflows"| Defs
    Client -->|"POST /workflows/:id/runs, returns 202 + runId"| Runs
    Client -->|"GET /runs/:id"| Runs
    Cron -->|start run with idempotency key| Runs

    Defs -->|writes| DefCol
    Runs -->|creates run + PENDING steps| RunCol
    Runs --> StepCol

    Sched -->|polls for ready steps| StepCol
    Sched -->|enqueues step id| Queue
    Queue -->|delivers at least once| W
    W -->|claims with lease, writes status and output| StepCol
    W --> TaskReg
    TaskReg -->|idempotent calls| Ext
    W -->|step finished event| Outbox
    Outbox -->|wakes| Sched

    W -.-> Obs
    Sched -.-> Obs
    API -.-> Obs
```

## 4. Target: lifecycle of one step

This state machine is the core of the engine. Every transition is a conditional
update on the `step_runs` document, so two workers can never both win.

```mermaid
stateDiagram-v2
    [*] --> PENDING: run created
    PENDING --> QUEUED: all dependencies SUCCEEDED
    PENDING --> SKIPPED: a dependency failed terminally
    QUEUED --> RUNNING: worker claims lease
    RUNNING --> SUCCEEDED: output stored
    RUNNING --> RETRYING: retryable error or timeout, attempts left
    RUNNING --> QUEUED: lease expired (worker died)
    RETRYING --> QUEUED: backoff elapsed
    RUNNING --> FAILED: terminal error or attempts exhausted
    RUNNING --> CANCELLED: run cancelled
    QUEUED --> CANCELLED: run cancelled
    FAILED --> COMPENSATING: saga rollback of earlier steps
    COMPENSATING --> [*]
    SUCCEEDED --> [*]
    SKIPPED --> [*]
    CANCELLED --> [*]
```

## How the roadmap maps onto diagram 3

| Stage | Piece of the diagram it builds |
| --- | --- |
| A1-A4 (done) | Task registry with a schema per task, Definitions API with versions |
| B1. Persisted run as a state machine | Runs API, `workflow_runs`, `step_runs`, diagram 4 |
| B2. API, scheduler and workers split | Scheduler, Queue, Workers, leases |
| B3. Failure semantics | Retry, timeout and idempotency inside the worker |
| B4. Parallelism and backpressure | N workers, concurrency limits on the queue |
| B5. Sagas and triggers | Cron and webhook triggers, outbox, `COMPENSATING` |
| B6. Operability | Logs, traces, metrics |
