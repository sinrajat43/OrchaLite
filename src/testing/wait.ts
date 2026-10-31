/**
 * Polls until a value is what the test is waiting for
 * @throws Error naming what it waited for, with the last value, on timeout
 */
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
