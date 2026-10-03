# OrchaLite architecture

Four diagrams: what the code does today (1, 2), and where the roadmap takes it (3, 4).

## 1. Today: one request runs the whole workflow

Everything happens inside the HTTP request. The run exists only in the memory of
one process, so a crash or a client timeout loses it.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant Ctl as WorkflowController
    participant Svc as WorkflowService
    participant Run as runWorkflow
    participant Reg as taskRegistry
    participant GH as GitHub API
    participant DB as MongoDB

    C->>Ctl: POST /workflow/run (name, steps)
    Ctl->>Svc: run(dto)
    Svc->>Svc: validate DTO, check task names exist
    Svc->>Run: runWorkflow(steps, taskRegistry)

    loop one step at a time, in dependency order
        Run->>Reg: look up task by name
        Run->>Run: collect outputs of dependsOn from in-memory results
        alt fetchRepos
            Run->>GH: GET /orgs/:org/repos
            GH-->>Run: repos
        else filterRepos
            Run->>Run: filter by minStars
        else storeRepos
            Run->>DB: RepoModel.create (whole array in one document)
        end
        Run->>Run: results[step.id] = output
    end

    Run-->>Svc: results (all step outputs)
    Svc-->>Ctl: results
    Ctl-->>C: 201 with every step output in the body
```

## 2. Today: modules and where the weak points are

```mermaid
flowchart TB
    Client([Client])

    subgraph Nest["NestJS process (single)"]
        direction TB
        Main["main.ts<br/>ValidationPipe, port 3000"]
        App["AppModule<br/>MongooseModule.forRoot"]
        Ctl["WorkflowController<br/>POST /workflow/run"]
        Svc["WorkflowService<br/>validates, calls runner"]
        Runner["runWorkflow<br/>task-runner.util.ts"]
        Results[("results map<br/>in memory only")]

        subgraph Tasks["Tasks: plain objects, outside Nest DI"]
            Registry["taskRegistry"]
            Fetch["fetchRepos"]
            Filter["filterRepos"]
            Store["storeRepos"]
        end
    end

    GitHub[(GitHub API)]
    Mongo[(MongoDB)]

    Client -->|HTTP, waits for full run| Ctl
    Main --> App --> Ctl
    Ctl --> Svc --> Runner
    Runner -->|reads and writes step outputs| Results
    Runner -->|looks up by name| Registry
    Registry --> Fetch & Filter & Store
    Fetch -->|no token, no retry, no timeout| GitHub
    Store -->|global mongoose model,<br/>second connection| Mongo
    App -.->|Nest connection, unused by tasks| Mongo

    classDef weak stroke:#d9480f,stroke-width:2px,stroke-dasharray:5 3;
    class Results,Runner,Store weak;
```

Dashed orange marks the weak points:

| Where | Problem |
| --- | --- |
| `results` map | Run state lives in memory. A crash loses the run; nothing can be inspected or resumed. |
| `runWorkflow` | Sequential only. A cycle or an unknown `dependsOn` id is skipped silently and the run still reports success. A step whose dependency returned a falsy value (for example `storeRepos`, which returns `void`) fails. |
| `storeRepos` | Uses the global `mongoose.model`, not the Nest-managed connection, so the app opens two connections. Stores the full array in one document (16MB limit). |

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
| 1. Persisted state machine | Runs API, `workflow_runs`, `step_runs`, diagram 4 |
| 2. API and worker split | Scheduler, Queue, Workers, leases |
| 3. Failure semantics | Retry, timeout and idempotency inside the worker |
| 4. Parallelism and backpressure | N workers, concurrency limits on the queue |
| 5. Data contracts | Definitions API, schema per task, output refs |
| 6. Sagas and triggers | Cron and webhook triggers, outbox, `COMPENSATING` |
| 7. Operability | Logs, traces, metrics |
