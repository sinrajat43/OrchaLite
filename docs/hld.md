# OrchaLite high-level design (current state)

What the code on `main` does today. For the target design and roadmap, see
[architecture.md](architecture.md) (diagrams 3 and 4) and [objective.md](objective.md).

## 1. System context

```mermaid
flowchart LR
    User([User / API client])
    Browser["Web UI<br/>public/index.html<br/>(no build step)"]

    subgraph App["OrchaLite (single NestJS process, port 3000)"]
        API["HTTP API<br/>/workflow/*"]
        Engine["Workflow engine<br/>validate DAG + run steps"]
        Tasks["Task registry<br/>fetchRepos · filterRepos · storeRepos"]
    end

    GitHub[(GitHub Search API)]
    Mongo[(MongoDB)]

    User -->|opens http://localhost:3000| Browser
    Browser -->|GET /workflow/tasks<br/>POST /workflow/run| API
    User -->|curl / scripts| API
    API --> Engine --> Tasks
    Tasks -->|"search/repositories?q=org:X<br/>(optional GITHUB_TOKEN)"| GitHub
    Tasks -->|insert one document per run| Mongo
```

## 2. Components

```mermaid
flowchart TB
    subgraph Boot["Bootstrap"]
        Main["main.ts<br/>dotenv, enableShutdownHooks, listen(PORT)"]
        Setup["app.setup.ts · configureApp<br/>static assets from /public<br/>global ValidationPipe (whitelist, forbidNonWhitelisted)"]
        AppMod["AppModule<br/>mongoose.connect on init<br/>mongoose.disconnect on shutdown"]
    end

    subgraph WF["WorkflowModule"]
        Ctl["WorkflowController<br/>GET /workflow/tasks<br/>POST /workflow/run"]
        DTO["CreateWorkflowDto<br/>name, steps[id, task, params, dependsOn]"]
        Svc["WorkflowService<br/>check task names exist<br/>map errors to 400 / 500"]
    end

    subgraph Orch["orchestrator/task-runner.util.ts"]
        Validate["validateWorkflow<br/>unique ids, known deps, no cycles"]
        Run["runWorkflow<br/>queue-based topological run,<br/>one step at a time"]
        Results[("results map<br/>in memory")]
    end

    subgraph TaskLayer["tasks/ (plain objects implementing Task)"]
        Iface["Task interface<br/>execute(input, params)<br/>TaskExecutionError"]
        Reg["taskRegistry"]
        Fetch["fetchRepos"]
        Filter["filterRepos"]
        Store["storeRepos"]
        Schema["repo.schema.ts<br/>getRepoModel(collectionName)"]
    end

    Main --> Setup
    Main --> AppMod --> WF
    Ctl -->|validated DTO| Svc
    DTO -.-> Ctl
    Svc --> Reg
    Svc --> Run
    Run --> Validate
    Run <--> Results
    Run -->|lookup by name| Reg
    Reg --> Fetch & Filter & Store
    Fetch & Filter & Store -.implements.-> Iface
    Store --> Schema
    Schema -->|default mongoose connection| Mongo[(MongoDB)]
    AppMod -->|opens the same connection| Mongo
    Fetch --> GH[(GitHub API)]
```

## 3. Request flow: `POST /workflow/run`

The whole run happens inside the HTTP request; the client waits for every step.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client / Web UI
    participant VP as ValidationPipe
    participant Ctl as WorkflowController
    participant Svc as WorkflowService
    participant Run as runWorkflow
    participant Reg as taskRegistry
    participant Ext as GitHub / MongoDB

    C->>VP: POST /workflow/run {name, steps}
    alt DTO invalid or unknown properties
        VP-->>C: 400
    end
    VP->>Ctl: CreateWorkflowDto
    Ctl->>Svc: run(dto)
    Svc->>Svc: every step.task in registry?
    alt missing tasks
        Svc-->>C: 400 "Invalid tasks in workflow"
    end
    Svc->>Run: runWorkflow(steps, taskRegistry)
    Run->>Run: validateWorkflow (dupes, unknown deps, cycles)
    alt not a DAG
        Run-->>Svc: WorkflowDefinitionError
        Svc-->>C: 400 "Invalid workflow definition"
    end

    loop queue of ready steps (deps all done), sequential
        Run->>Run: inputs = results[dep] for each dependsOn<br/>(single dep → value, many → array)
        Run->>Reg: taskRegistry[step.task]
        Run->>Ext: task.execute(input, params)
        Ext-->>Run: output
        Run->>Run: results[step.id] = output
    end

    alt a task throws
        Run-->>Svc: TaskExecutionError(stepId, task)
        Svc-->>C: 500 {message, stepId, task}
    else all steps succeed
        Run-->>Svc: results
        Svc-->>C: 201 {stepId: output, ...}
    end
```

## 4. Data model

```mermaid
classDiagram
    class CreateWorkflowDto {
        +string name
        +WorkflowStepDto[] steps
    }
    class WorkflowStepDto {
        +string id
        +string task
        +Record params?
        +string[] dependsOn
    }
    class Task {
        <<interface>>
        +execute(input, params) Promise~TOutput~
    }
    class TaskExecutionError {
        +string taskId
        +string taskName
        +Error cause?
    }
    class WorkflowDefinitionError {
        +string[] issues
    }
    class Repo {
        +number id
        +string name
        +number stargazers_count
    }
    class RepoDocument {
        <<MongoDB>>
        +Date timestamp
        +Array data
    }

    CreateWorkflowDto "1" *-- "1..*" WorkflowStepDto
    WorkflowStepDto ..> Task : task name → registry
    Task ..> TaskExecutionError : throws
    RepoDocument o-- Repo : data[]
```

## 5. Built-in task pipeline (example workflow)

```mermaid
flowchart LR
    F["fetch<br/>fetchRepos<br/>org, perPage, page"]
    Fi["filter<br/>filterRepos<br/>minStars"]
    S["store<br/>storeRepos<br/>collectionName"]
    F -->|"Repo[] sorted by stars"| Fi -->|"Repo[] with ≥ minStars"| S -->|void| Done([run result])
```

## Known limits today

| Area | Limit |
| --- | --- |
| Durability | Run state is the in-memory `results` map; a crash or client timeout loses the run. No run history. |
| Execution | Steps run sequentially even when independent; no parallelism. |
| Failure handling | No retries, no timeouts; first failure aborts the run. |
| Tasks | Plain objects outside Nest DI; registry is a static import. |
| Storage | `storeRepos` writes the whole array into one document (16MB cap). |
