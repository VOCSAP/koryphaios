import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function canonicalConfigPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    const missing: string[] = [];
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
    try {
      return join(realpathSync.native(existing), ...missing);
    } catch {
      return absolute;
    }
  }
}
