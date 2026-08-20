// Card 69e5a3e0. Cold, one-shot migration. shared/project-key.ts's
// normalizeRemoteUrl now lowercases the owner/repo path in addition to the
// host (it used to lowercase the host only), so every table with a
// project_key column written before that fix may carry a mixed-case key
// that no longer matches what the fixed code computes at runtime -- two
// clones of the same repo, cloned under different casing, used to land in
// two different roadmap/graph/approval scopes with no error signal.
//
// MUST RUN COLD: broker AND every session stopped first, then this script,
// then restart. Never against a live broker (--dry-run or otherwise): 22
// sessions were writing project_key concurrently at the time this card was
// filed, and this script's own idempotent WHERE-clause guarantee only holds
// between two runs of ITSELF, not against a writer racing it mid-transaction.
//
// TABLE DISCOVERY IS BY SCHEMA INTROSPECTION (sqlite_master + PRAGMA
// table_info), never a hand-written list. This card exists because a
// hand-written enumeration of "the tables with project_key" (4 tables) was
// short one -- approval_session_tokens (broker.ts:741, added via ALTER
// TABLE) -- for two days, undetected because nothing forced the list to stay
// exhaustive. A future 6th project_key-bearing table is picked up
// automatically here. No exclusion list on principle: even the ephemeral
// `peers` table (re-derived on every registration, so migrating it changes
// nothing observable) is migrated, because an exclusion list is exactly the
// hand-written-enumeration defect this script exists not to repeat.
//
// UNIQUE-constraint check (done once, by reading this file's own measurement
// rather than re-deriving it every run): as of 2026-08-20 this schema has
// exactly two UNIQUE constraints in the whole database (peers(peer_id,
// group_id) and approval_channels(operator_id, kind, address)) and NEITHER
// includes project_key. A mass UPDATE lowercasing project_key therefore
// cannot throw a UNIQUE-constraint violation today. This is not re-verified
// at runtime (schema can drift after this comment is written), which is
// exactly why the collision check below exists independently of it: it does
// not rely on this fact staying true.
//
// COLLISION = a table where a lowercase form of a key is ALREADY present
// (literal data) alongside a mixed-case form that would migrate to it. This
// is checked for ALL discovered tables BEFORE any UPDATE runs, so a
// collision found in table N never leaves tables 1..N-1 already migrated.
// On any collision, in any table: REFUSE, write nothing, exit non-zero. This
// script never merges silently.
//
// Usage:
//   bun scripts/migrate-project-key-case.ts --db <path/to/broker.sqlite>            (dry-run; default; writes nothing)
//   bun scripts/migrate-project-key-case.ts --db <path/to/broker.sqlite> --write    (commit)
//
// --db has NO default and is required on purpose: this script never guesses
// where the broker's sqlite file lives (config.db in broker.ts resolves it
// from env/config at broker boot, which this standalone script does not
// import or replicate).

import { Database } from "bun:sqlite";

// Every function below is pure over a `Database` handle (no argv, no
// filesystem path) so tests/migrate-project-key-case.test.ts can exercise
// the discovery/collision/migration logic against an in-memory (`:memory:`)
// database -- no real or on-disk file touched, satisfying this card's "no
// execution against a real database" constraint while still proving the
// logic red-then-green.

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
  // bun:sqlite only applies its documented default ({readwrite: true,
  // create: true}) when NONE of readonly/create/readwrite are present in
  // the options object at all -- passing `{readonly: false}` alone (no
  // `create`/`readwrite`) leaves every SQLITE_OPEN_* flag unset and throws
  // "bad parameter or other API misuse" (measured directly against a real
  // on-disk file, 2026-08-20; both flags-omitted defaults and
  // flags-fully-explicit work, an explicit `readonly: false` alone does
  // not). Every branch below sets all three explicitly so behavior never
  // depends on that undocumented default-merging.
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
