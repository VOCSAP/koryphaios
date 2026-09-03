// Must run cold: stop the broker and every session first, then run this, then
// restart. The idempotent WHERE-clause guarantee holds only between two runs of
// itself, never against a concurrent writer.
// Tables are discovered by schema introspection (sqlite_master + PRAGMA
// table_info), never a hardcoded list, so a newly added project_key column is
// picked up automatically.
// Every discovered table is checked for a lowercase/mixed-case collision before
// any UPDATE runs; a collision in any table refuses the whole run and writes
// nothing.
// --db has no default: it never guesses where the broker's sqlite file lives.

import { Database } from "bun:sqlite";

export interface Args {
  dbPath: string;
  write: boolean;
}

export function parseArgs(argv: string[]): Args {
  let dbPath: string | null = null;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
      dbPath = argv[++i] ?? null;
    } else if (a === "--write") {
      write = true;
    } else if (a === "--dry-run") {
      // Accepted as a no-op: dry-run is already the default without --write.
      // Naming it explicitly at the call site is allowed for clarity.
    } else {
      throw new Error(`unknown argument: ${a} (usage: --db <path> [--write])`);
    }
  }
  if (!dbPath) {
    throw new Error("missing required --db <path>; this script never guesses the broker's db path");
  }
  return { dbPath, write };
}

export function quoteIdent(name: string): string {
  // Table names here always come from sqlite_master itself (this process's
  // own discovery query below), never from argv or network input -- this
  // quoting is defense-in-depth, not a trust boundary.
  return `"${name.replace(/"/g, '""')}"`;
}

export function discoverProjectKeyTables(db: Database): string[] {
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();
  const found: string[] = [];
  for (const { name } of tables) {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(name)})`).all();
    // PRAGMA table_info returns the column name AS DECLARED (case preserved).
    // SQLite itself treats column names case-insensitively, so a column
    // declared `PROJECT_KEY` is the same column at the engine level -- match
    // it the same way, or such a table silently drops out of discovery.
    if (cols.some((c) => c.name.toLowerCase() === "project_key")) found.push(name);
  }
  return found;
}

// CASING COMPARISONS ARE JS-SIDE, NEVER SQL LOWER(). SQLite's built-in
// LOWER() is ASCII-only; JS String.prototype.toLowerCase() is Unicode-aware
// (the same function shared/project-key.ts's normalizeRemoteUrl already
// uses at runtime, via `.toLowerCase()`). Measured divergence:
// "github.com/VOCSAP/ÉTÉ" -> SQL LOWER() gives "github.com/vocsap/ÉtÉ" (the
// accented letters are left untouched), JS .toLowerCase() gives the correct
// "github.com/vocsap/été". Using SQL LOWER() anywhere in this script's
// write path would therefore mint a THIRD key on any non-ASCII repo path
// (self-hosted GitLab/Gitea, common cross-host) that no runtime code will
// ever produce again -- the exact silent-split defect this whole card
// exists to close, reintroduced one layer down. Every function below
// fetches the DISTINCT raw values and classifies/transforms them in JS.

interface DistinctValue {
  value: string;
  count: number;
}

function distinctProjectKeyValues(db: Database, table: string): DistinctValue[] {
  const t = quoteIdent(table);
  return db
    .query<{ value: string; count: number }, []>(
      `SELECT project_key AS value, COUNT(*) AS count FROM ${t}
       WHERE project_key IS NOT NULL AND project_key != ''
       GROUP BY project_key`
    )
    .all();
}

export interface CollisionReport {
  lowered: string;
  forms: string[];
}

export function findCollisions(db: Database, table: string): CollisionReport[] {
  const byLower = new Map<string, string[]>();
  for (const { value } of distinctProjectKeyValues(db, table)) {
    const lowered = value.toLowerCase();
    const forms = byLower.get(lowered);
    if (forms) forms.push(value);
    else byLower.set(lowered, [value]);
  }
  const collisions: CollisionReport[] = [];
  for (const [lowered, forms] of byLower) {
    if (forms.length > 1) collisions.push({ lowered, forms });
  }
  return collisions;
}

export interface CasingCounts {
  total: number;
  mixedCase: number;
  alreadyLower: number;
  nullOrEmpty: number;
}

export function countByCasing(db: Database, table: string): CasingCounts {
  const t = quoteIdent(table);
  const total = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0;
  let mixedCase = 0;
  let alreadyLower = 0;
  for (const { value, count } of distinctProjectKeyValues(db, table)) {
    if (value === value.toLowerCase()) alreadyLower += count;
    else mixedCase += count;
  }
  return { total, mixedCase, alreadyLower, nullOrEmpty: total - mixedCase - alreadyLower };
}

function formatCounts(c: CasingCounts): string {
  return `total=${c.total} mixed-case=${c.mixedCase} already-lower=${c.alreadyLower} null-or-empty=${c.nullOrEmpty}`;
}

export type MigrateResult =
  | { status: "no-tables" }
  | { status: "collision"; collisions: Map<string, CollisionReport[]> }
  | { status: "dry-run"; tables: string[]; before: Map<string, CasingCounts> }
  | { status: "written"; tables: string[]; before: Map<string, CasingCounts>; after: Map<string, CasingCounts> };

/**
 * The logic main() drives, extracted so tests can call it directly against
 * an in-memory Database -- no argv, no console, no filesystem path. Mirrors
 * main()'s phases exactly: discover, collision-check ALL tables, then (only
 * if `write`) migrate ALL tables in one transaction.
 */
export function migrateAll(db: Database, write: boolean): MigrateResult {
  const tables = discoverProjectKeyTables(db);
  if (tables.length === 0) return { status: "no-tables" };

  const collisionsByTable = new Map<string, CollisionReport[]>();
  for (const t of tables) {
    const collisions = findCollisions(db, t);
    if (collisions.length > 0) collisionsByTable.set(t, collisions);
  }
  if (collisionsByTable.size > 0) return { status: "collision", collisions: collisionsByTable };

  const before = new Map<string, CasingCounts>();
  for (const t of tables) before.set(t, countByCasing(db, t));

  if (!write) return { status: "dry-run", tables, before };

  const migrate = db.transaction(() => {
    for (const t of tables) {
      const tq = quoteIdent(t);
      const stmt = db.query(`UPDATE ${tq} SET project_key = ? WHERE project_key = ?`);
      for (const { value } of distinctProjectKeyValues(db, t)) {
        const lowered = value.toLowerCase();
        if (lowered !== value) stmt.run(lowered, value);
      }
    }
  });
  migrate();

  const after = new Map<string, CasingCounts>();
  for (const t of tables) after.set(t, countByCasing(db, t));
  return { status: "written", tables, before, after };
}

/**
 * readonly:true when NOT writing is a second, mechanical guarantee behind
 * the --write gate: a dry-run cannot write even if a bug slipped an UPDATE
 * past migrateAll's own `if (!write) return` branch. Extracted so a test can
 * open a real on-disk db this way and prove a write attempt against the
 * readonly handle actually throws -- a comment asserting this without
 * anything exercising it is exactly the gap this extraction closes.
 */
export function openForMode(dbPath: string, write: boolean): Database {
  // bun:sqlite only applies its {readwrite:true, create:true} default when none
  // of readonly/create/readwrite are set at all; an explicit `{readonly:
  // false}` alone leaves every SQLITE_OPEN_* flag unset and throws.
  // Every branch below sets all three flags explicitly so behavior never
  // depends on that default-merging.
  return write
    ? new Database(dbPath, { readonly: false, readwrite: true, create: true })
    : new Database(dbPath, { readonly: true, create: false });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = openForMode(args.dbPath, args.write);

  console.log(`[migrate-project-key-case] db=${args.dbPath} mode=${args.write ? "WRITE" : "DRY-RUN"}`);

  const result = migrateAll(db, args.write);

  if (result.status === "no-tables") {
    console.log("[migrate-project-key-case] discovered 0 table(s) with a project_key column. Nothing to do.");
    return;
  }

  if (result.status === "collision") {
    console.error(
      "[migrate-project-key-case] REFUSING: a lowercase form of a key already coexists " +
        "with a mixed-case form of the same key in at least one table. Nothing written. " +
        "This script never merges silently -- resolve manually, then re-run."
    );
    for (const [t, reports] of result.collisions) {
      for (const r of reports) {
        console.error(`  table=${t} target="${r.lowered}" existing_forms=${JSON.stringify(r.forms)}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log(`[migrate-project-key-case] discovered ${result.tables.length} table(s) with a project_key column:`);
  for (const t of result.tables) console.log(`  - ${t}`);
  console.log("[migrate-project-key-case] no collision in any discovered table.");
  console.log("[migrate-project-key-case] before:");
  for (const t of result.tables) console.log(`  ${t}: ${formatCounts(result.before.get(t)!)}`);

  if (result.status === "dry-run") {
    console.log("[migrate-project-key-case] DRY-RUN: no write performed. Pass --write to commit.");
    return;
  }

  console.log("[migrate-project-key-case] after:");
  for (const t of result.tables) {
    const c = result.after.get(t)!;
    const b = result.before.get(t)!;
    console.log(`  ${t}: ${formatCounts(c)} (changed ${b.mixedCase - c.mixedCase} row(s))`);
  }
  console.log("[migrate-project-key-case] done.");
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    // Any SQLite-level error (e.g. a readonly-write attempt, a locked db)
    // would otherwise surface as a raw Bun stack trace -- print the refusal
    // shape the operator already knows how to read instead.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[migrate-project-key-case] ERROR: ${msg}`);
    process.exitCode = 1;
  }
}
