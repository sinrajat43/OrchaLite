import { ChildProcess, execSync, spawn } from 'child_process';
import { createServer } from 'net';
import { AddressInfo } from 'net';

/** Whether tests can start a Redis. CI must have one, so there a missing one fails rather than skips. */
export function redisAvailable(): boolean {
  try {
    execSync('command -v redis-server', { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    if (process.env.CI) throw new Error('redis-server is not on the PATH');
    return false;
  }
}

const freePort = () =>
  new Promise<number>(resolve => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/**
 * Starts a throwaway Redis that keeps nothing on disk, on a free port. The
 * default port is left alone, so a Redis already running there is never touched.
 */
export async function startTestRedis(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const server: ChildProcess = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'pipe' });
  const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Redis did not start: ${output}`)), 20_000);
    server.once('error', reject);
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Ready to accept connections')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    url: `redis://127.0.0.1:${port}`,
    stop: async () => {
      server.kill('SIGKILL');
      await exited;
    },
  };
}
