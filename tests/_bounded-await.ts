/**
 * Awaits a promise the test relies on a collaborator to settle, and turns a
 * promise that never settles into a named failure instead of a runner that
 * hangs: bun's per-test timeout does not interrupt an await on a promise that
 * is never resolved.
 */
export async function reachedWithin<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not reached within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
