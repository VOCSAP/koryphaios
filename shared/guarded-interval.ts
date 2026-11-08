export interface TimerLog {
  warn(message: string): void;
  error(message: string, context?: unknown): void;
}

/**
 * setInterval whose failures are traced and never escape, and whose passes
 * never overlap: a tick that finds the previous asynchronous pass still
 * running is skipped, so a slow pass cannot start a second one beside it.
 */
export function guardedInterval(name: string, fn: () => unknown, ms: number, log: TimerLog): ReturnType<typeof setInterval> {
  let running = false;
  const failed = (error: unknown): void => log.error(`timer ${name}: iteration failed (skipped)`, error);
  return setInterval(() => {
    if (running) {
      log.warn(`timer ${name}: previous pass still running, tick skipped`);
      return;
    }
    let pending: unknown;
    try {
      pending = fn();
    } catch (error) {
      failed(error);
      return;
    }
    if (pending instanceof Promise) {
      running = true;
      pending.catch(failed).finally(() => {
        running = false;
      });
    }
  }, ms);
}
