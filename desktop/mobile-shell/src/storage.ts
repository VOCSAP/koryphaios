// Persistence seam for the shell (PLAN N5 / MB6).
//
// Everything the shell remembers goes through this interface, for one reason:
// the modules that own the two pairings must be testable under `bun test`, and
// the Android build does not exist in this container. On the device the
// implementation is Capacitor Preferences; in a browser it is localStorage; in
// a test it is a Map.
//
// It is deliberately SYNCHRONOUS. Capacitor Preferences is async, so the app
// entry point loads every key once at start-up into a memory store and writes
// through — which is also what makes the state modules pure functions over a
// snapshot rather than a tangle of awaits.

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** In-memory store: the test double, and the buffer behind the async ones. */
export class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  /** Everything currently held, for a write-through implementation to flush. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/**
 * Read a JSON value, falling back when it is absent OR unreadable.
 *
 * Never throws: a corrupted preference must degrade to "not paired", which the
 * operator can fix by scanning again, rather than to a white screen on a phone
 * with no console attached.
 */
export function readJson<T>(store: KeyValueStore, key: string, fallback: T): T {
  const raw = store.get(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  store.set(key, JSON.stringify(value));
}
