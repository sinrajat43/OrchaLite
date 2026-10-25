import { Injectable, Module, Scope } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Type } from '@sinclair/typebox';
import { Task } from '../tasks/task.interface';
import { TaskHandler } from '../tasks/task-handler.decorator';
import { OrchestratorModule } from './orchestrator.module';
import { TaskRegistry } from './task-registry.service';

const task = (output: unknown) =>
  class implements Task {
    readonly paramsSchema = Type.Object({});
    readonly outputSchema = Type.Any();
    async execute() {
      return output;
    }
  };

@TaskHandler({ name: 'echo', version: 1 })
class EchoV1 extends task('v1') {}

@TaskHandler({ name: 'echo', version: 2 })
class EchoV2 extends task('v2') {}

@TaskHandler({ name: 'other', version: 1 })
class Other extends task('other') {}

@Injectable()
class NotATask {}

const bootWith = async (...providers: any[]) => {
  @Module({ imports: [OrchestratorModule], providers })
  class TestModule {}

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false });
  return { app, registry: app.get(TaskRegistry) };
};

describe('TaskRegistry', () => {
  it('discovers @TaskHandler providers from any module and ignores other providers', async () => {
    const { app, registry } = await bootWith(EchoV1, Other, NotATask);

    expect(registry.names().sort()).toEqual(['echo', 'other']);
    await expect(registry.get('other').execute(undefined)).resolves.toBe('other');
    expect(registry.get('missing')).toBeUndefined();
    await app.close();
  });

  it('resolves a name to its latest version', async () => {
    const { app, registry } = await bootWith(EchoV2, EchoV1);

    await expect(registry.get('echo').execute(undefined)).resolves.toBe('v2');
    expect(registry.names()).toEqual(['echo']);
    await app.close();
  });

  it('refuses to start when a name and version are registered twice', async () => {
    @TaskHandler({ name: 'echo', version: 1 })
    class EchoV1Again extends task('again') {}

    await expect(bootWith(EchoV1, EchoV1Again)).rejects.toThrow('Task echo v1 is registered twice');
  });

  it('refuses to start when a task is missing part of the contract', async () => {
    @TaskHandler({ name: 'noSchema', version: 1 })
    class NoSchema {
      async execute() {
        return 1;
      }
    }

    await expect(bootWith(NoSchema)).rejects.toThrow(
      'Task NoSchema (noSchema v1) must define execute(), paramsSchema and outputSchema'
    );
  });

  it('refuses to start when a task is not a singleton', async () => {
    @Injectable({ scope: Scope.REQUEST })
    @TaskHandler({ name: 'scoped', version: 1 })
    class Scoped extends task('scoped') {}

    await expect(bootWith(Scoped)).rejects.toThrow('Task Scoped (scoped v1) must be a singleton provider');
  });
});
