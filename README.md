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

Workflows are defined as JSON and sent to the `/workflow/run` endpoint. Each workflow consists of:

- A name
- A list of steps, where each step has:
  - `id`: Unique identifier for the step
  - `task`: Name of the task to execute
  - `params`: Optional parameters for the task
  - `dependsOn`: Array of step IDs this step depends on

### Example Workflow

```json
{
  "name": "github-repo-analysis",
  "steps": [
    {
      "id": "fetch",
      "task": "fetchRepos",
      "params": {
        "org": "github",
        "perPage": 100
      },
      "dependsOn": []
    },
    {
      "id": "filter",
      "task": "filterRepos",
      "params": {
        "minStars": 1000
      },
      "dependsOn": ["fetch"]
    },
    {
      "id": "store",
      "task": "storeRepos",
      "params": {
        "collectionName": "popular-repos"
      },
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
- `minStars` (optional): Minimum number of stars (default: 1000)

### 3. storeRepos
Stores repository data in MongoDB.

**Parameters:**
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
Executes a workflow.

**Request Body:**
```json
{
  "name": "workflow-name",
  "steps": [
    {
      "id": "step-id",
      "task": "task-name",
      "params": {},
      "dependsOn": []
    }
  ]
}
```

**Response:**
Returns the results of all steps in the workflow.

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
├── tasks/                 # Task implementations
│   ├── task.interface.ts
│   ├── task-registry.ts
│   ├── fetchRepos.task.ts
│   ├── filterRepos.task.ts
│   └── storeRepos.task.ts
├── orchestrator/          # Workflow execution engine
│   └── task-runner.util.ts
└── schemas/              # MongoDB schemas
    └── repo.schema.ts
```

## Adding New Tasks

1. Create a new task file in `src/tasks/`
2. Implement the `Task` interface
3. Add the task to the `taskRegistry` in `src/tasks/task-registry.ts`

Example task implementation:
```typescript
import { Task } from './task.interface';

interface MyTaskParams {
  param1?: string;
  param2?: number;
}

export const myTask: Task<InputType, OutputType, MyTaskParams> = {
  async execute(input: InputType, params?: MyTaskParams): Promise<OutputType> {
    // Task implementation
  }
};
```

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