# OrchaLite

A lightweight workflow orchestration engine built with NestJS that allows you to define and execute workflows as Directed Acyclic Graphs (DAGs) of tasks.

Where the project is heading: [objective and roadmap](docs/objective.md) · [architecture diagrams](docs/architecture.md)

## Features

- **DAG-based Workflow Execution**: Define workflows as a series of dependent tasks
- **Type-safe Task System**: Strongly typed task inputs, outputs, and parameters
- **Extensible Task Registry**: Easily add new tasks to the system
- **MongoDB Integration**: Persistent storage of workflow results
- **Input Validation**: Built-in validation for workflow definitions
- **Error Handling**: Comprehensive error handling and logging

## Prerequisites

- Node.js (v14 or higher)
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

### Example Workflow

The GitHub pipeline, built from generic tasks only. This and the other examples
in the web UI live in [`public/examples.json`](public/examples.json) and are
run end to end by the test suite.

```json
{
  "name": "popular-repos",
  "input": {
    "org": { "type": "string", "pattern": "^[A-Za-z0-9-]+$" },
    "minStars": { "type": "integer", "minimum": 0, "default": 1000 }
  },
  "steps": [
    {
      "id": "fetch",
      "task": "http.request",
      "params": {
        "url": "https://api.github.com/search/repositories",
        "query": { "q": "org:{{ input.org }}", "sort": "stars", "order": "desc", "per_page": 100 }
      },
      "dependsOn": []
    },
    {
      "id": "popular",
      "task": "filter",
      "params": {
        "items": "{{ steps.fetch.output.body.items }}",
        "where": "stargazers_count >= $minStars",
        "vars": { "minStars": "{{ input.minStars }}" }
      },
      "dependsOn": ["fetch"]
    },
    {
      "id": "save",
      "task": "mongo.insert",
      "params": {
        "collection": "repos",
        "documents": { "org": "{{ input.org }}", "repos": "{{ steps.popular.output }}" },
        "timestampField": "timestamp"
      },
      "dependsOn": ["popular"]
    }
  ]
}
```

## Available Tasks

`GET /tasks` lists every task with JSON Schemas for its params and output. A
step's params are checked against the schema when the workflow is submitted
(values that are expressions are checked once resolved, just before the step
runs), so a typo in a param name or a wrong type is rejected up front.

| Task | Does | Key params | Output |
| --- | --- | --- | --- |
| `http.request` | Calls an HTTP endpoint | `url`, `method`, `query`, `headers`, `body`, `timeoutMs`, `throwOnError` | `{ ok, status, headers, body, durationMs, error? }` |
| `transform` | Returns `value` once its expressions are resolved, to reshape data | `value` | the value |
| `filter` | Keeps items for which a JSONata condition holds | `items`, `where` (per item, reads `vars` as `$name`), `vars` | the kept items |
| `mongo.insert` | Inserts documents into a collection | `collection`, `documents`, `timestampField` | `{ insertedCount }` |
| `notify.webhook` | POSTs JSON, failing unless the answer is 2xx | `url`, `payload`, `headers` | `{ status }` |
| `delay` | Waits, in process, up to 60s | `ms` | `{ waitedMs }` |

`http.request` fails the step on a network error or a non-2xx status. With
`throwOnError: false` it reports them in the output instead, which suits a
health check.

`filter`'s `where` is code, so it may not contain `{{ ... }}`: splicing data
into it would let the data change the condition. Pass values in through `vars`.

## Web UI

With the app running, open http://localhost:3000 for a single-page UI (`public/index.html`, no build step):

- Edit a workflow as JSON, or load one of the built-in examples
- Give the run its input as JSON
- See the steps drawn as a dependency graph, with problems (unknown steps or tasks, cycles) flagged as you type
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

**Response:** `201` with the run id and each step's status and output:

```json
{ "runId": "…", "steps": { "step-id": { "status": "succeeded", "output": "…" } } }
```

`400` lists every problem with the definition (`Invalid workflow definition`)
or the input (`Invalid run input`). `500` names the step that failed.

## Project Structure

```
src/
├── main.ts                 # Application entry point
├── app.module.ts           # Root module, MongoDB connection
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

## Error Handling

The system includes comprehensive error handling:
- Input validation errors
- Task execution errors
- Dependency resolution errors
- Database errors
- API errors

All errors are logged and propagated appropriately.

## Future Enhancements

Planned features:
- Workflow status tracking
- Task timeout handling
- Retry mechanisms
- Workflow versioning
- Result caching
- Monitoring and metrics

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details. 