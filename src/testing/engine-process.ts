import { ChildProcess, execFileSync, spawn } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const outDir = (suite: string) => join(ROOT, 'build', 'e2e', suite);

let built: string | undefined;

/**
 * Compiles the app, so tests can start it as real processes that can really be
 * killed. Each suite has its own directory, because suites run in parallel and
 * one must not start a process from files another is rewriting.
 */
export function buildEngine(suite: string): void {
  built = outDir(suite);
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', join(ROOT, 'tsconfig.build.json'), '--outDir', built, '--incremental', 'false'], {
    stdio: 'pipe',
  });
}

export interface EngineProcess {
  child: ChildProcess;
  /** Kills the process with no chance to clean up */
  kill: () => Promise<void>;
  /** Asks it to stop, and resolves once it has exited */
  stop: () => Promise<void>;
  output: () => string;
}

/**
 * Starts the app in its own process
 * @param env - Must include MONGODB_URI and ORCHALITE_ROLES
 */
export function startEngineProcess(env: Record<string, string>): EngineProcess {
  const child = spawn(process.execPath, [join(built, 'main.js')], {
    cwd: built,
    env: { ...process.env, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));

  const signal = async (name: NodeJS.Signals) => {
    child.kill(name);
    await exited;
  };
  return { child, kill: () => signal('SIGKILL'), stop: () => signal('SIGTERM'), output: () => output };
}
