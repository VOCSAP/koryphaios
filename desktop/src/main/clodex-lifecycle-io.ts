export interface SqliteStatement {
  run(...values: unknown[]): { changes: number | bigint };
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
}

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export interface ClodexLifecycleRecords {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  createExclusive<T>(key: string, value: T): Promise<boolean>;
  remove(key: string): Promise<void>;
  removeIfEquals<T>(key: string, expected: T): Promise<boolean>;
  list<T>(prefix: string): Promise<T[]>;
}

export interface ClodexLifecycleRecordsOptions {
  busyTimeoutMs?: number;
}

const TABLE = "clodex_lifecycle_records";
const DEFAULT_BUSY_TIMEOUT_MS = 100;

function encodeJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("SQLite records require finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("SQLite records cannot contain cycles");
    ancestors.add(value);
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError("SQLite records cannot contain sparse arrays");
      entries.push(encodeJson(value[index], ancestors));
    }
    ancestors.delete(value);
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError("SQLite records cannot contain cycles");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("SQLite records require plain objects");
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const encoded = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeJson(record[key], ancestors)}`)
      .join(",");
    ancestors.delete(value);
    return `{${encoded}}`;
  }
  throw new TypeError("SQLite records require JSON values");
}

function decodeJson<T>(value: string): T {
  const decoded: unknown = JSON.parse(value);
  if (encodeJson(decoded) !== value) throw new TypeError("SQLite record JSON is not canonical");
  return decoded as T;
}

function readValue(row: unknown): string | null {
  if (row === undefined) return null;
  if (typeof row !== "object" || row === null || !("value" in row) || typeof row.value !== "string") {
    throw new TypeError("SQLite record row is invalid");
  }
  return row.value;
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function changedOnce(changes: number | bigint): boolean {
  return changes === 1 || changes === 1n;
}

function resolveBusyTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new RangeError("SQLite busy timeout must be a non-negative 32-bit integer");
  }
  return timeout;
}

export function createSqliteRecordStore(
  db: SqliteConnection,
  options: ClodexLifecycleRecordsOptions = {},
): ClodexLifecycleRecords {
  const busyTimeoutMs = resolveBusyTimeout(options.busyTimeoutMs);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`);

  return {
    async read<T>(key: string): Promise<T | null> {
      const value = readValue(db.prepare(`SELECT "value" FROM ${TABLE} WHERE "key" = ?`).get(key));
      return value === null ? null : decodeJson<T>(value);
    },

    async write<T>(key: string, value: T): Promise<void> {
      const encoded = encodeJson(value);
      db.prepare(
        `INSERT INTO ${TABLE} ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
      ).run(key, encoded);
    },

    async createExclusive<T>(key: string, value: T): Promise<boolean> {
      const encoded = encodeJson(value);
      return changedOnce(db.prepare(`INSERT OR IGNORE INTO ${TABLE} ("key", "value") VALUES (?, ?)`).run(key, encoded).changes);
    },

    async remove(key: string): Promise<void> {
      db.prepare(`DELETE FROM ${TABLE} WHERE "key" = ?`).run(key);
    },

    async removeIfEquals<T>(key: string, expected: T): Promise<boolean> {
      const encoded = encodeJson(expected);
      return changedOnce(db.prepare(`DELETE FROM ${TABLE} WHERE "key" = ? AND "value" = ?`).run(key, encoded).changes);
    },

    async list<T>(prefix: string): Promise<T[]> {
      return db.prepare(`SELECT "value" FROM ${TABLE} WHERE "key" LIKE ? ESCAPE '\\' ORDER BY "key"`)
        .all(`${escapeLikePrefix(prefix)}%`)
        .map((row) => {
          const value = readValue(row);
          if (value === null) throw new TypeError("SQLite list row is missing a value");
          return decodeJson<T>(value);
        });
    },
  };
}
