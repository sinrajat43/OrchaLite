# OrchaLite

A lightweight workflow orchestration engine built with NestJS that allows you to define and execute workflows as Directed Acyclic Graphs (DAGs) of tasks.

Where the project is heading: [objective and roadmap](docs/objective.md) · [architecture diagrams](docs/architecture.md)

## Features

- **Declarative workflows**: JSON definitions of steps and dependencies, run as a DAG
- **Expressions**: JSONata in `{{ ... }}` wires run input and earlier outputs into params
- **Control flow**: `when` to skip steps, `forEach` to run a step per item
- **Generic tasks**: HTTP, transform, filter, MongoDB and webhook primitives, discovered as plugins
- **Validation up front**: graph, expressions, references and params schemas are checked before anything runs
- **Stored, versioned definitions** and **encrypted connections** for credentials
- **Web UI**: edit, graph, run, store, and watch notifications arrive

## Prerequisites

- Node.js 18 or higher
- MongoDB (local or Atlas)

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/orchalite.git
cd orchalite

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your configuration
```

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Encryption key for connections (named credentials); without it /connections is disabled
# Generate one with: openssl rand -base64 32
ORCHALITE_SECRET_KEY=

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/orchalite
# For MongoDB Atlas, use:
# MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/orchalite

# Application Configuration
PORT=3000
NODE_ENV=development
```

## Running the Application

```bash
# Development
npm run start

# Watch mode
npm run start:dev

# Production
npm run start:prod
```

## Defining Workflows

A workflow definition is JSON:

- `name`
- `input` (optional): the values a run must supply, by name. Each is a JSON
  Schema type name (`string`, `number`, `integer`, `boolean`, `object`,
  `array`) or a full JSON Schema; one with a `default` is optional.
- `steps`, where each step has:
  - `id`: Unique identifier for the step
  - `task`: Name of the task to execute
  - `params`: Parameters for the task, which may contain expressions
  - `dependsOn`: Array of step IDs this step depends on
  - `when` (optional): a `{{ ... }}` condition; when false, the step and
    everything downstream of it is skipped
  - `forEach` (optional): a `{{ ... }}` list; the step runs once per item, and
    its params can read `item` and `index`. Its output is the list of outputs.

### Expressions

A string in `params` can contain [JSONata](https://jsonata.org) expressions in
`{{ ... }}`. They read the run input as `input.<name>` and an upstream step's
output as `steps.<id>.output`, and are resolved just before the step runs.

- A string that is one expression, such as `"{{ steps.fetch.output }}"`,
  becomes the expression's value, of any type.
- A string that mixes text and expressions, such as `"org:{{ input.org }}"`,
  becomes a string.
- Inside a filter, `$$` reaches the root again:
  `"{{ steps.fetch.output[stargazers_count >= $$.input.minStars] }}"`.
  JSONata returns a single match as a value rather than a one-item array;
  append `[]` to always get an array.

A definition is checked before any step runs. Expressions must parse, may only
read steps the step depends on (directly or indirectly), and may only read
declared input.

### Control flow

```json
{ "id": "check", "task": "http.request", "forEach": "{{ input.endpoints }}",
  "params": { "url": "{{ item }}", "throwOnError": false }, "dependsOn": [] },
{ "id": "down", "task": "filter",
  "params": { "items": "{{ steps.check.output }}", "where": "ok = false" }, "dependsOn": ["check"] },
{ "id": "alert", "task": "notify.webhook", "when": "{{ $count(steps.down.output) > 0 }}",
  "params": { "url": "{{ input.webhookUrl }}", "payload": { "text": "{{ $join(steps.down.output.url, ', ') }} down" } },
  "dependsOn": ["down"] }
```

`forEach` runs items one at a time and is capped at 1,000 items; each item gets
its own idempotency key (`runId:stepId:index`). A skipped step's result says
why: `when was false`, or `dependency "x" was skipped`.

### Example workflows

[`public/examples.json`](public/examples.json) holds the examples offered in
the web UI; an end-to-end test runs each of them.

| Example | Shows |
| --- | --- |
| `uptime-alert` | `forEach` over endpoints, `filter`, a `when`-guarded notification |
| `release-watcher` | Reads the last seen release from MongoDB, notifies only on a change, then records it |
| `popular-repos` | Search, filter, reshape and store, with primitives only |
| `branching-example` | Two steps reading one upstream output |
| three invalid ones | What submit-time validation catches |

The uptime and release examples notify the built-in [webhook inbox](#webhook-inbox).

## Available Tasks

`GET /tasks` lists every task with JSON Schemas for its params and output. A
step's params are checked against the schema when the workflow is submitted
(values that are expressions are checked once resolved, just before the step
runs), so a typo in a param name or a wrong type is rejected up front.

| Task | Does | Key params | Output |
| --- | --- | --- | --- |
| `http.request` | Calls an HTTP endpoint | `url`, `connection`, `method`, `query`, `headers`, `body`, `timeoutMs`, `throwOnError` | `{ url, ok, status, headers, body, durationMs, error? }` |
| `transform` | Returns `value` once its expressions are resolved, to reshape data | `value` | the value |
| `filter` | Keeps items for which a JSONata condition holds | `items`, `where` (per item, reads `vars` as `$name`), `vars` | the kept items |
| `mongo.insert` | Inserts documents into a collection | `collection`, `documents`, `timestampField` | `{ insertedCount }` |
| `mongo.findOne` | Reads one document by field equality | `collection`, `filter` | the document without `_id`, or `null` |
| `mongo.upsert` | Updates the document matching a filter, creating it if missing | `collection`, `filter`, `set`, `timestampField` | `{ created, modified }` |
| `notify.webhook` | POSTs JSON, failing unless the answer is 2xx | `url`, `connection`, `payload`, `headers` | `{ status }` |
| `delay` | Waits, in process, up to 60s | `ms` | `{ waitedMs }` |

`http.request` fails the step on a network error or a non-2xx status. With
`throwOnError: false` it reports them in the output instead, which suits a
health check.

`filter`'s `where` is code, so it may not contain `{{ ... }}`: splicing data
into it would let the data change the condition. Pass values in through `vars`.
For the same reason, MongoDB filters are equality only: field names cannot
start with `$` and values are scalars, so data cannot become an operator.

## Connections

A connection holds credentials for HTTP calls, so definitions never contain
secrets. Its headers and query params are encrypted with AES-256-GCM using
`ORCHALITE_SECRET_KEY`, bound to the connection's name, and never returned by
the API.

```bash
curl -X PUT localhost:3000/connections/github -H 'Content-Type: application/json' \
  -d '{ "type": "http", "baseUrl": "https://api.github.com", "headers": { "Authorization": "Bearer <token>" } }'
```

A step then uses `"connection": "github"` with a relative `url` such as
`/repos/nestjs/nest/releases/latest`. The credentials are only sent to URLs
under the connection's `baseUrl`; pointing an absolute `url` elsewhere fails the
step. For a webhook whose URL is itself the secret (Slack), store the URL as the
`baseUrl` and give `notify.webhook` only the connection.

## Webhook inbox

`POST /inbox/<channel>` records any JSON payload in memory (the latest 100), and
`GET /inbox` lists them. It is a local stand-in for Slack or similar, so the
alerting examples can be tried without an account; the web UI shows it.

## Web UI

With the app running, open http://localhost:3000 for a single-page UI (`public/index.html`, no build step):

- Edit a workflow as JSON, or load one of the built-in examples
- Give the run its input as JSON
- Save the workflow as a new stored version, and load or run stored workflows
- Add and delete connections (secrets are write-only)
- Watch notifications arrive in the webhook inbox
- See the steps drawn as a dependency graph, with problems (unknown steps or tasks, cycles) flagged as you type, `forEach` and `when` steps marked, and skipped steps greyed out after a run
- Browse the task catalogue with each task's params and output schemas
- Run it and inspect each step's output, or the error and the step that failed

Results appear when the whole run has finished; there is no run history or live progress yet.

## API Endpoints

### GET /tasks
Returns the task catalogue: name, version, description, and the JSON Schemas of
each task's params and output.

### POST /workflow/run
Runs a workflow definition with the given input, inside the request.

**Request Body:**
```json
{
  "definition": {
    "name": "workflow-name",
    "input": { "org": "string" },
    "steps": [
      { "id": "step-id", "task": "task-name", "params": { "org": "{{ input.org }}" }, "dependsOn": [] }
    ]
  },
  "input": { "org": "nestjs" }
}
```

**Response:** `201` with the run id and each step's result:

```json
{ "runId": "…", "steps": {
    "step-id": { "status": "succeeded", "output": "…" },
    "each-step": { "status": "succeeded", "output": ["…"], "iterations": 1 },
    "later": { "status": "skipped", "reason": "when was false" } } }
```

`400` lists every problem with the definition (`Invalid workflow definition`)
or the input (`Invalid run input`). `500` names the step that failed.

### Stored workflows

| Endpoint | Does |
| --- | --- |
| `POST /workflows` | Validates a definition and stores it as the next version of its `name`; resubmitting the latest unchanged returns that version (`created: false`) |
| `GET /workflows` | Each name with its latest version and version count |
| `GET /workflows/:name` | The latest version |
| `GET /workflows/:name/versions`, `GET /workflows/:name/versions/:version` | History, and one version |
| `POST /workflows/:name/runs` | Runs a stored version (`{ input, version? }`, latest by default) inside the request; the response adds `workflow: { name, version }` |

Versions are immutable. A unique index on `(name, version)` settles concurrent
saves: each reads the latest version and tries to claim the next, and a loser
reads again.

### Connections and inbox

| Endpoint | Does |
| --- | --- |
| `PUT /connections/:name` | Creates or replaces `{ type: "http", baseUrl, headers?, query? }`; returns only the names of secret values |
| `GET /connections` | Lists connections without secrets |
| `DELETE /connections/:name` | Deletes one |
| `POST /inbox/:channel`, `GET /inbox`, `DELETE /inbox` | The local webhook inbox |

## Project Structure

```
src/
├── main.ts                 # Application entry point
├── app.module.ts           # Root module, MongoDB connection
├── api.module.ts           # Every HTTP feature module
├── definitions/            # /workflows: versioned definition store
├── connections/            # /connections: SecretBox (AES-256-GCM), service
├── inbox/                  # /inbox: local webhook target
├── workflows/              # HTTP API
│   ├── workflow.controller.ts    # POST /workflow/run
│   ├── tasks.controller.ts       # GET /tasks
│   ├── workflow.service.ts
│   └── dto/workflow.dto.ts
├── orchestrator/           # Workflow engine
│   ├── workflow-definition.ts    # Validates and compiles a definition
│   ├── task-runner.util.ts       # Runs a compiled workflow
│   ├── task-registry.service.ts  # Discovers @TaskHandler providers
│   └── schema-validator.ts       # Ajv
├── expressions/
│   └── template.ts               # {{ }} templates, JSONata, reference checks
├── tasks/                  # Task contract and the built-in tasks
│   ├── task.interface.ts         # Task and TaskContext
│   ├── task-handler.decorator.ts # @TaskHandler({ name, version, description })
│   ├── tasks.module.ts           # Built-in task catalogue
│   └── *.task.ts
└── testing/                # Test helpers: task contexts, local HTTP server, throwaway MongoDB
```

Tests that need MongoDB start a throwaway instance with `mongodb-memory-server`,
using the `mongod` on the PATH when there is one.

## Adding New Tasks

1. Create a task class in `src/tasks/`: implement `Task`, describe its params
   and output with [TypeBox](https://github.com/sinclairzx81/typebox) schemas,
   and mark it with `@TaskHandler({ name, version })`
2. List it in the `providers` of `TasksModule` (or any module in the app)

`TaskRegistry` discovers it at startup; no engine code changes. A step's `task`
field uses the name and gets the latest version.

```typescript
import { Static, Type } from '@sinclair/typebox';
import { Task, TaskContext } from './task.interface';
import { TaskHandler } from './task-handler.decorator';

const GreetParamsSchema = Type.Object({ name: Type.String() });
type GreetParams = Static<typeof GreetParamsSchema>;

@TaskHandler({ name: 'greet', version: 1 })
export class GreetTask implements Task<GreetParams, string> {
  readonly paramsSchema = GreetParamsSchema;
  readonly outputSchema = Type.String();

  async execute({ params, logger }: TaskContext<GreetParams>): Promise<string> {
    logger.log(`Greeting ${params.name}`);
    return `Hello, ${params.name}`;
  }
}
```

The context also carries an abort `signal`, the `attempt` number and an
`idempotencyKey` stable per run and step. Params are validated against
`paramsSchema` before `execute` runs, with defaults filled in. For checks a
schema cannot express, implement `validate(params)`; it runs at submit time on
the params as written.

## Errors

- `400 Invalid workflow definition` lists every problem with a definition at once
- `400 Invalid run input` lists every problem with the input
- `500` names the step that failed (`stepId`, `task`) and why

## What comes next

Runs still happen inside the HTTP request and are lost on a crash. Phase B of
the [roadmap](docs/objective.md) makes them durable: persisted runs, a
scheduler and workers with leases, retries and timeouts, parallelism, sagas,
triggers, and observability.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details. 