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
- GitHub Personal Access Token (for GitHub API tasks)

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
# GitHub API Configuration
GITHUB_TOKEN=your_github_personal_access_token

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

```json
{
  "name": "github-repo-analysis",
  "input": {
    "org": "string",
    "minStars": { "type": "integer", "default": 1000 }
  },
  "steps": [
    {
      "id": "fetch",
      "task": "fetchRepos",
      "params": { "org": "{{ input.org }}", "perPage": 100 },
      "dependsOn": []
    },
    {
      "id": "filter",
      "task": "filterRepos",
      "params": { "repos": "{{ steps.fetch.output }}", "minStars": "{{ input.minStars }}" },
      "dependsOn": ["fetch"]
    },
    {
      "id": "store",
      "task": "storeRepos",
      "params": { "repos": "{{ steps.filter.output }}", "collectionName": "popular-repos" },
      "dependsOn": ["filter"]
    }
  ]
}
```

## Available Tasks

### 1. fetchRepos
Fetches repositories from GitHub API.

**Parameters:**
- `org` (optional): GitHub organization name (default: "github")
- `perPage` (optional): Number of repos per page (default: 100)
- `page` (optional): Page number (default: 1)

### 2. filterRepos
Filters repositories based on star count.

**Parameters:**
- `repos`: The repositories to filter
- `minStars` (optional): Minimum number of stars (default: 1000)

### 3. storeRepos
Stores repository data in MongoDB.

**Parameters:**
- `repos`: The repositories to store
- `collectionName` (optional): MongoDB collection name; letters, digits, `_` and `-` only (default: "repos")

## Web UI

With the app running, open http://localhost:3000 for a single-page UI (`public/index.html`, no build step):

- Edit a workflow as JSON, or load one of the built-in examples
- See the steps drawn as a dependency graph, with problems (unknown steps or tasks, cycles) flagged as you type
- Run it and inspect each step's output, or the error and the step that failed

Results appear when the whole run has finished; there is no run history or live progress yet.

## API Endpoints

### GET /workflow/tasks
Returns the names of the registered tasks.

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
├── app.module.ts           # Root module
├── workflows/             # Workflow-related code
│   ├── workflow.controller.ts
│   ├── workflow.service.ts
│   └── dto/
│       └── create-workflow.dto.ts
├── tasks/                 # Task contract and implementations
│   ├── task.interface.ts         # Task and TaskContext
│   ├── task-handler.decorator.ts # @TaskHandler({ name, version })
│   ├── tasks.module.ts           # Built-in task catalogue
│   ├── fetchRepos.task.ts
│   ├── filterRepos.task.ts
│   └── storeRepos.task.ts
├── orchestrator/          # Workflow execution engine
│   ├── orchestrator.module.ts
│   ├── task-registry.service.ts  # Discovers @TaskHandler providers
│   └── task-runner.util.ts
└── schemas/              # MongoDB schemas
    └── repo.schema.ts
```

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

The context also carries `input` (dependency outputs), an abort `signal`, the
`attempt` number and an `idempotencyKey` stable per run and step. Schemas are
declared but not yet enforced; validation at submit time arrives in stage A3.

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