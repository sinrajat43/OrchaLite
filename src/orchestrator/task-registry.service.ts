import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Task } from '../tasks/task.interface';
import { TaskHandler, TaskHandlerOptions } from '../tasks/task-handler.decorator';

export interface RegisteredTask extends TaskHandlerOptions {
  task: Task;
}

/**
 * Looks up the task a step names. Satisfied by TaskRegistry, or by a plain Map in tests.
 */
export interface TaskLookup {
  get(name: string): Task | undefined;
}

/**
 * Collects every @TaskHandler provider in the app at startup
 */
@Injectable()
export class TaskRegistry implements OnModuleInit, TaskLookup {
  // name -> version -> task
  private readonly tasks = new Map<string, Map<number, RegisteredTask>>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({ metadataKey: TaskHandler.KEY })) {
      const options = this.discovery.getMetadataByDecorator(TaskHandler, wrapper);
      const label = `${wrapper.name} (${options.name} v${options.version})`;

      // Request-scoped and transient providers have no single instance to call
      if (!wrapper.isDependencyTreeStatic() || !wrapper.instance) {
        throw new Error(`Task ${label} must be a singleton provider`);
      }

      const task = wrapper.instance as Task;
      if (typeof task.execute !== 'function' || !task.paramsSchema || !task.outputSchema) {
        throw new Error(`Task ${label} must define execute(), paramsSchema and outputSchema`);
      }

      const versions = this.tasks.get(options.name) ?? new Map<number, RegisteredTask>();
      if (versions.has(options.version)) {
        throw new Error(`Task ${options.name} v${options.version} is registered twice`);
      }
      versions.set(options.version, { ...options, task });
      this.tasks.set(options.name, versions);
    }
  }

  /**
   * Returns the latest version of the named task
   */
  get(name: string): Task | undefined {
    const versions = this.tasks.get(name);
    if (!versions) return undefined;
    return versions.get(Math.max(...versions.keys())).task;
  }

  names(): string[] {
    return [...this.tasks.keys()];
  }

  /**
   * Every registered version of every task, sorted by name then version
   */
  list(): RegisteredTask[] {
    return [...this.tasks.values()]
      .flatMap(versions => [...versions.values()])
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }
}
