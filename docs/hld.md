# OrchaLite high-level design (current state)

What the code on `main` does as of 2026-10-25: phase A (generality) done, run
history recorded, and a canvas builder. For where it is heading, see
[objective.md](objective.md) and the target diagrams in
[architecture.md](architecture.md).

## 1. System context

```mermaid
flowchart LR
    User([User])
    Classic["Classic UI<br/>/ (index.html)<br/>JSON editor, run history"]
    Builder["Canvas builder<br/>/builder.html<br/>plans, drag and drop"]
    Scripts([API clients, curl])

    subgraph App["OrchaLite: one NestJS process"]
        API["HTTP API"]
        Engine["Workflow engine<br/>validate, then run in the request"]
        Tasks["Task catalogue<br/>@TaskHandler plugins"]
        History["Run recorder"]
    end

    Mongo[(MongoDB)]
    Ext[(External HTTP APIs)]
    Hooks[(Webhook targets,<br/>or the local /inbox)]

    User --> Classic & Builder
    Classic & Builder & Scripts --> API
    API --> Engine --> Tasks
    Engine -->|hooks| History --> Mongo
    API --> Mongo
    Tasks -->|http.request| Ext
    Tasks -->|notify.webhook| Hooks
    Tasks -->|mongo.*| Mongo
```

## 2. Modules

```mermaid
flowchart TB
    subgraph Boot["Bootstrap"]
        Main["main.ts<br/>listen(PORT), shutdown hooks"]
        Setup["app.setup.ts<br/>static /public, global ValidationPipe"]
        AppMod["AppModule<br/>mongoose.connect"]
    end

    subgraph Api["ApiModule"]
        Runs["RunsModule (global)<br/>RunsController /runs<br/>RunRecorder, RunStore port"]
        Wf["WorkflowModule<br/>WorkflowController /workflow/run<br/>TasksController /tasks<br/>WorkflowService"]
        Defs["DefinitionsModule<br/>DefinitionsController /workflows<br/>DefinitionStore"]
        Conns["ConnectionsModule<br/>/connections<br/>SecretBox AES-256-GCM"]
        Inbox["InboxModule<br/>/inbox (memory)"]
    end

    subgraph Engine["Engine"]
        Orch["OrchestratorModule<br/>TaskRegistry via DiscoveryService"]
        Def["workflow-definition.ts<br/>validate and compile"]
        Runner["task-runner.util.ts<br/>runWorkflow, RunHooks"]
        Expr["expressions/template.ts<br/>{{ }} JSONata, reference checks"]
        Schema["schema-validator.ts<br/>Ajv"]
    end

    TasksM["TasksModule<br/>http.request, transform, filter,<br/>mongo.insert, mongo.findOne, mongo.upsert,<br/>notify.webhook, delay"]

    Main --> Setup
    Main --> AppMod --> Api
    Wf --> Runner
    Wf -->|prepare per run| Runs
    Defs -->|run a stored version| Wf
    Runner --> Def --> Expr & Schema
    Runner --> Orch
    Orch -.->|discovers @TaskHandler| TasksM
    Runner -->|ctx.connections| Conns
```

## 3. Running a workflow

```mermaid
sequenceDiagram
    autonumber
    participant UI as Client / UI
    participant API as WorkflowController or DefinitionsController
    participant Svc as WorkflowService
    participant Rec as RunHandle
    participant Run as runWorkflow
    participant T as Task
    participant DB as MongoDB

    alt ad hoc (classic editor, builder draft)
        UI->>API: POST /workflow/run { definition, input }
    else stored (saved workflow, builder plan)
        UI->>API: POST /workflows/:name/runs { input, version? }
        API->>DB: load that version
    end
    API->>Svc: run(definition, input, workflow?)
    Svc->>Rec: prepare: run id and hooks
    Svc->>Run: runWorkflow(definition, tasks, { input, connections, runId, hooks })
    Run->>Run: validate graph, tasks, expressions, input, params schemas
    alt rejected
        Run-->>UI: 400 with every problem (nothing recorded)
    end
    Run->>Rec: onRunStarted
    Rec->>DB: RunStarted
    loop each step in dependency order
        Run->>Run: skip (when false, skipped dependency) or resolve params, per forEach item
        Run->>T: execute(ctx)
        T-->>Run: output
        Run->>Rec: onStepStarted, onStepFinished or onStepFailed
        Rec->>DB: step events, summary
    end
    Svc->>Rec: succeed or fail
    Rec->>DB: RunSucceeded or RunFailed
    Svc-->>UI: 201 { runId, steps } or 500 { stepId, task, runId }
```

## 4. Data

| Collection | Owner | Holds |
| --- | --- | --- |
| `workflow_definitions` | DefinitionStore | Immutable versions per name; unique `(name, version)` |
| `connections` | ConnectionsService | Base URL and secrets encrypted with `ORCHALITE_SECRET_KEY` |
| `run_events` | MongoRunStore | Append-only run timeline; unique `(runId, seq)` |
| `workflow_runs` | MongoRunStore | One summary per run, rebuilt from its events |
| any (task-chosen) | `mongo.insert`, `mongo.upsert` | Workflow data, such as stored repos or a release watcher's last version |

In the browser (builder only): drafts and per-workflow layout in
`localStorage`.

```mermaid
erDiagram
    workflow_definitions ||--o{ workflow_runs : "stored runs reference name + version"
    workflow_runs ||--o{ run_events : "timeline"
    workflow_definitions {
        string name
        int version
        string source "definition JSON as submitted"
        string hash
        date createdAt
    }
    workflow_runs {
        string _id "run id"
        string status
        object workflow "name, version"
        object input
        array steps "status, timing, error, reason"
        int lastSeq
    }
    run_events {
        string runId
        int seq
        string type
        object data
    }
    connections {
        string name
        string baseUrl
        string secrets "encrypted"
    }
```

## 5. Front ends

| Page | For | Talks to |
| --- | --- | --- |
| `/` classic UI | JSON editing with live graph, stored workflows, connections, inbox, **run history** with step timeline, `/#run=<id>` links | `/tasks`, `/workflow/run`, `/workflows`, `/connections`, `/inbox`, `/runs` |
| `/builder.html` | **Plans**: canvas, schema-driven param forms, run inputs and a checked run form, versions, drafts, upload and download | `/tasks`, `/examples.json`, `/workflows`, `/workflow/run`, `/runs` |

Both are single static files with no build step. See [builder.md](builder.md).

## 6. Known limits

Sections 2 to 4 above were written before phase B. For how runs execute now, with
the scheduler, workers and queue, see [engine-design.md](engine-design.md).

| Area | Limit | Roadmap |
| --- | --- | --- |
| Queue | MongoDB only; the BullMQ adapter is not built | B2 |
| Triggers | API only, with no UI | Not planned yet |
| Scheduling cost | Each pass reads all of a run's rows, so very large fan-outs spend most of their time here | Not planned yet |
| Overlapping runs | A workflow's `concurrency` limits steps, not runs | Open |
| Stored workflows | Versions cannot be deleted | Not planned yet |
| Builder | Drafts and layout are per browser; no undo or zoom; retry, timeout and compensate are kept in a definition but cannot be edited on the canvas | Horizon 4 for the full editor |
