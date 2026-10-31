import { ChildProcess, execFileSync, spawn } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(ROOT, 'build', 'e2e');

/** Compiles the app, so tests can start it as real processes that can really be killed */
export function buildEngine(): void {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', join(ROOT, 'tsconfig.build.json'), '--outDir', OUT_DIR, '--incremental', 'false'], {
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
  const child = spawn(process.execPath, [join(OUT_DIR, 'main.js')], {
    cwd: OUT_DIR,
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
