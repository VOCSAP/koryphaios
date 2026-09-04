// shared/approval-scope.ts stops a caller from building an identity clause
// without a scope, but cannot stop SQL that bypasses the module entirely.
// This scan is that missing half: a new statement or file touching
// pending_approvals fails until an exemption below argues in writing why it may
// be unscoped.

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TABLE = "pending_approvals";

/** The composers whose presence anywhere in the window proves scoping. */
const SCOPE_MARKERS = ["${where.sql}", "stamped.columns"];

/**
 * `approvalTileWhere` is WEAKER than `approvalWhere` (no session_ref), so its
 * marker is accepted only on the ONE statement it exists for, anchored on a
 * fragment unique to that site -- the same discipline UNSCOPED_BY_DESIGN uses
 * for its own exemptions -- rather than treated as an equivalent-strength
 * marker on any statement that happens to reuse the variable name
 * `tileWhere`.
 */
const WEAK_SCOPE_MARKER = "${tileWhere.sql}";
const WEAK_SCOPE_MARKER_SITE_ANCHOR = "mergeable = 1";

/**
 * Files allowed to name the table at all. Anything else fails, which is what
 * makes a NEW file the default-refused case rather than an unnoticed one.
 */
const ALLOWED_FILES = new Set([
  "broker.ts",
  join("shared", "approval-scope.ts"),
  join("tests", "broker-approvals.test.ts"),
  join("tests", "desktop-approval-scope.test.ts"),
  join("tests", "desktop-approval-scope-discipline.test.ts"),
  // card 69e5a3e0: this file replays broker.ts's own CREATE/ALTER TABLE
  // statements as a schema mirror and inserts one fixture row per table via
  // DDL, not application logic acting for a caller.
  // The exemption covers only that replay, not an unscoped query added
  // elsewhere in this file that impersonates a caller.
  join("tests", "migrate-project-key-case.test.ts"),
]);

/**
 * Statements in `broker.ts` that legitimately carry no scope. Each key is a
 * distinctive fragment of the statement; each value is the argument. A new
 * unscoped statement is refused until it appears here WITH a reason, so the
 * reason is written at the moment it is still known.
 */
const UNSCOPED_BY_DESIGN: Record<string, string> = {
  "CREATE TABLE IF NOT EXISTS pending_approvals":
    "DDL. Defines the table; there are no rows yet and no caller to scope to.",
  "CREATE INDEX IF NOT EXISTS idx_approvals_operator":
    "DDL. An index selects no rows and returns nothing to anybody.",
  "CREATE INDEX IF NOT EXISTS idx_approvals_project":
    "DDL. Same as above; it exists precisely to make the scoped clause fast.",
  "ALTER TABLE pending_approvals ADD COLUMN":
    "DDL. Idempotent column migrations, run once at boot with no caller present.",
  "UPDATE pending_approvals SET status = 'abandoned'":
    "One-shot migration of rows predating project scoping (card 1def56da). Global on purpose: it repairs EVERY operator's legacy rows, and no caller is acting.",
  "UPDATE pending_approvals SET status = 'expired_notif'":
    "Notification TTL sweep. A maintenance job with no caller and no identity, so there is nothing to scope it BY.",
  // card d3f23918: anchored on the specific status pair and TTL comparison
  // unique to sweepApprovals's purge statement, not the bare table name, so an
  // unrelated unscoped DELETE elsewhere cannot silently match this exemption.
  "status IN ('answered','abandoned') AND created_at < datetime('now'":
    "Retention purge (sweepApprovals). Same reason as the sweep above: a maintenance job with no caller and no identity to scope by.",
  "readonly [SCOPE_BRAND]":
    "Not SQL. The table name is the BRAND of the opaque scope type, which is deliberately named after the thing it authorises so a reader knows what it unlocks.",
  "readonly [STAMP_BRAND]":
    "Not SQL. Same reason as the scope brand above: the stamp is branded with the table its columns are written into.",
  "[approvalId]":
    "The read INSIDE scopeForAnsweredRow, the gateway path's only SQL. It is what PRODUCES a scope from a row, so scoping it would require the answer it exists to produce. It is safe for the reason the old exported form was not: the caller supplies an id and nothing else, so it cannot name its own operator or project.",

  // An exemption is deleted, not left dormant, once the site it covers is gone:
  // a stale exemption protecting nothing reads as live and gets copied.
  // Every exemption here must be anchored on something unique to the one site
  // it covers, never a bare SQL fragment that could match elsewhere.
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "out", "release", ".aidex"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * A line that OPENS a fresh SQL call. A statement cannot contain the start of
 * another one, so this is the boundary the window must never cross -- see the
 * B1/B2 note on `statementAt` below for why the paren counter alone cannot be
 * trusted to find that boundary by itself. Matches both a full opener
 * (`db.run(`, `deps.queryOne(`) and a bare continuation (`.query(` on its own
 * line, the shape the legitimate multi-line probes in this file use).
 * `.all(`/`.get(` are deliberately absent: they extract a RESULT from a call
 * already open, they do not start a new one.
 */
const STATEMENT_OPENER = /\.(?:run|query|queryOne|queryAll|prepare)\s*\(/;

/** How many lines past a statement's own start this scan will still search. */
const MAX_STATEMENT_LINES = 5;

/**
 * Ends at the statement's own end by balancing parentheses from the opening db
 * call, not a fixed line count.
 * A string literal with an unpaired parenthesis (a LIKE pattern) can desync the
 * depth counter, so the window also stops the moment it sees a line opening a
 * new SQL call.
 * The horizon is capped at a handful of lines rather than resolved
 * indefinitely, so an unresolved window reads as unscoped instead of continuing
 * to search.
 */
function statementAt(lines: string[], start: number): string {
  let depth = 0;
  let seen = false;
  const parts: string[] = [];
  for (let i = start; i < lines.length && i < start + MAX_STATEMENT_LINES; i++) {
    const line = lines[i] ?? "";
    if (i > start && STATEMENT_OPENER.test(line)) break;
    parts.push(line);
    for (const ch of line) {
      if (ch === "(") {
        depth++;
        seen = true;
      } else if (ch === ")") depth--;
    }
    // A statement ends when its parentheses balance again, or at the semicolon
    // of a call that opened none (a bare `db.run(...)` on one line balances on
    // that same line, which is the common case and the cheapest to get right).
    if (seen && depth <= 0) break;
    if (!seen && line.includes(";")) break;
  }
  return parts.join("\n");
}

/** The files that legitimately write SQL against the protected table. */
const SQL_BEARING_FILES = ["broker.ts", join("shared", "approval-scope.ts")];

/**
 * Strips only a trailing `//` comment; naive by design.
 * A `//` inside a string literal would truncate the line early, but that only
 * produces a false positive (fail-closed), and no statement in the scanned
 * files contains one.
 */
function codeOnly(line: string): string {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
}

/**
 * Distinguishes code that reaches the table from prose merely naming it in a
 * comment or doc block, case-insensitively and across split names (e.g. string
 * concatenation).
 * A guard that flags documentation of the table trains people to stop
 * documenting it.
 */
function namesTableInCode(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
  // D2, MEASURED: matched case-sensitively and as a whole word, so
  // `PENDING_APPROVALS` and `"pending_" + "approvals"` both slipped through.
  // Lower-casing closes the first; looking for the HALVES closes the second,
  // since a scan that only knows the assembled name cannot see a name the
  // source never assembles.
  const lower = codeOnly(line).toLowerCase();
  return lower.includes(TABLE) || (lower.includes("pending_") && lower.includes("approvals"));
}

/** Whole-file form of the predicate above. Used by the audit AND by its probes. */
function fileNamesTable(source: string): boolean {
  return source.split("\n").some(namesTableInCode);
}

/**
 * THE predicate. One body, used by the real audit AND by the bite probes.
 *
 * A1, MEASURED, and the worst defect of the three: the audit and the probes
 * used to share `statementAt`, `SCOPE_MARKERS`, `UNSCOPED_BY_DESIGN` and
 * `TABLE`, but each carried its OWN copy of the loop. Review mutated one line
 * of the audit's copy (`line.toLowerCase()` back to `line`) with an
 * upper-cased offender present in `broker.ts`: the file reported 4 pass, all
 * five probes still green. The probes attested a function the audit did not
 * call. Sharing the parser was not sharing the predicate, which is the same
 * trap one level up from the one this scan exists to catch.
 */
function offendersIn(source: string, label: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // The naming test lives in `namesTableInCode` so this audit and the
    // file-level one below cannot disagree about what "reaches the table"
    // means. Merging them is the fix for the false positive documented there.
    if (!namesTableInCode(line)) continue;
    const window = statementAt(lines, i)
      .split("\n")
      .map(codeOnly)
      .join("\n");
    if (SCOPE_MARKERS.some((m) => window.includes(m))) continue;
    if (window.includes(WEAK_SCOPE_MARKER) && window.includes(WEAK_SCOPE_MARKER_SITE_ANCHOR)) continue;
    if (Object.keys(UNSCOPED_BY_DESIGN).some((frag) => window.includes(frag))) continue;
    found.push(`${label}:${i + 1}: ${line.trim().slice(0, 100)}`);
  }
  return found;
}

describe("no unscoped SQL reaches pending_approvals", () => {
  test("only the sanctioned files name the table at all", () => {
    const offenders: string[] = [];
    for (const file of walk(REPO_ROOT)) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWED_FILES.has(rel) || ALLOWED_FILES.has(rel.split("/").join(sep))) continue;
      if (fileNamesTable(readFileSync(file, "utf-8"))) offenders.push(rel);
    }
    expect(
      offenders,
      `These files reach the approvals table without going through shared/approval-scope.ts. ` +
        `If that is deliberate, add the file to ALLOWED_FILES here AND say why in its own comment; ` +
        `if it is not, route the query through approvalWhere(scope).`
    ).toEqual([]);
  });

  test("every statement in the SQL-bearing files is scoped, or argued in writing", () => {
    const offenders: string[] = [];
    for (const rel of SQL_BEARING_FILES) {
      offenders.push(...offendersIn(readFileSync(join(REPO_ROOT, rel), "utf-8"), rel));
    }
    expect(
      offenders,
      `Unscoped SQL on ${TABLE}. Compose the clause with approvalWhere(scope), or add the ` +
        `statement to UNSCOPED_BY_DESIGN with the argument for why it has no identity to scope by.`
    ).toEqual([]);
  });

  /**
   * These probes call offendersIn, the same function the audit above uses, not
   * a reimplementation -- so the audit cannot silently diverge from what the
   * probes cover.
   */
  const clean = (src: string): boolean => offendersIn(src, "probe").length === 0;

  test("the scan BITES on each evasion review measured, and still accepts the legitimate form", () => {
    // Four probes, each closing a DIFFERENT green the reviewer measured. They
    // live in the commit rather than being run once by hand: a probe nobody
    // replays is not a guard. The last case is the positive pin -- without it,
    // a scan that refused everything would satisfy the first four.
    const cases: Array<[string, string, boolean]> = [
      [
        "plain unscoped read",
        [`const rows = db`, `  .query("SELECT * FROM ${TABLE} WHERE status = 'pending'")`, `  .all();`].join("\n"),
        false,
      ],
      [
        // D1. The killer, because it LOOKS scoped to a line-window scan: the
        // clause it finds belongs to the statement below.
        "unscoped read sitting directly above a scoped one",
        [
          `const leak = db.query("SELECT * FROM ${TABLE} WHERE id = ?").get(x);`,
          `const ok = db`,
          `  .query(\`SELECT * FROM ${TABLE} WHERE \${where.sql}\`)`,
          `  .all(...where.params);`,
        ].join("\n"),
        false,
      ],
      [
        // D2a. Case.
        "table named in upper case",
        [`db.query("SELECT * FROM ${TABLE.toUpperCase()} WHERE id = ?").get(x);`].join("\n"),
        false,
      ],
      [
        // D2b. Never assembled in the source, so a scan looking only for the
        // whole name reads a file that appears not to mention the table.
        "table name built by concatenation",
        [`db.query("SELECT * FROM " + "pending_" + "approvals" + " WHERE id = ?").get(x);`].join("\n"),
        false,
      ],
      [
        // B3. The clause is in a COMMENT, so it vouches for nothing.
        "unscoped read whose trailing comment merely mentions the marker",
        [`db.query("SELECT * FROM ${TABLE} WHERE id = ?").get(x); // unlike \${where.sql} above`].join("\n"),
        false,
      ],
      [
        // B1, MEASURED (card d3f23918): a string literal carrying an UNPAIRED
        // parenthesis (a LIKE pattern here) desyncs the depth counter, so the
        // window never closes on its own statement and runs on into the next
        // one, inheriting ITS ${where.sql} marker.
        "unscoped read whose own text contains an unpaired parenthesis",
        [
          `const leak = db.query("SELECT * FROM ${TABLE} WHERE note LIKE '%(unmatched%'").get(x);`,
          `const ok = db`,
          `  .query(\`SELECT * FROM ${TABLE} WHERE \${where.sql}\`)`,
          `  .all(...where.params);`,
        ].join("\n"),
        false,
      ],
      [
        // B2, MEASURED (card d3f23918): every filler line the table mention
        // sits among opens no paren and carries no semicolon (array-element
        // text, not statements), so the OLD 40-line cap let the scan run
        // clean past all of it and close on the FIRST line that happened to
        // balance -- the neighbour's own self-contained call, several lines
        // away, swallowing its ${where.sql} marker.
        "unscoped mention with no end-of-statement nearby, followed later by a scoped read",
        [
          `  "about ${TABLE} maybe",`,
          `  "filler 2",`,
          `  "filler 3",`,
          `  "filler 4",`,
          `  "filler 5",`,
          `  "filler 6",`,
          `  "filler 7",`,
          `  "filler 8",`,
          `const ok = db.query(\`SELECT * FROM ${TABLE} WHERE \${where.sql}\`).all(...where.params);`,
        ].join("\n"),
        false,
      ],
      [
        // B4, MEASURED (card d3f23918): the OLD purge exemption key was the
        // generic fragment "DELETE FROM pending_approvals", excusing a SHAPE
        // rather than a SITE -- any new unscoped DELETE sharing that literal
        // text passed silently. This is what such a DELETE looks like: same
        // table, unrelated WHERE clause, no scope marker.
        "unscoped DELETE elsewhere carrying the same table name as the real purge",
        [`db.run("DELETE FROM ${TABLE} WHERE id = ?", [id]);`].join("\n"),
        false,
      ],
      [
        "the legitimate scoped form",
        [`const rows = db`, `  .query(\`SELECT * FROM ${TABLE} WHERE \${where.sql}\`)`, `  .all(...where.params);`].join("\n"),
        true,
      ],
    ];
    for (const [label, src, expected] of cases) {
      expect(clean(src), `probe "${label}"`).toBe(expected);
    }
  });

  test("the FILE scan ignores prose and still refuses a new file that reaches the table", () => {
    // These probes call fileNamesTable, the function the audit itself uses, not
    // a copy of its logic.
    // The four negative-control cases make the relaxation a refinement rather
    // than a hole in what the guard flags.
    const cases: Array<[string, string, boolean]> = [
      [
        "prose in a doc block, the false positive this refinement fixes",
        ["/**", ` * ... between an idle session and a row in \`${TABLE}\`.`, " */", "const x = 1;"].join("\n"),
        false,
      ],
      ["a line comment naming the table", [`// we never insert into ${TABLE} here`].join("\n"), false],
      [
        "real SQL in a file nobody sanctioned",
        [`const r = db.query("SELECT * FROM ${TABLE} WHERE id = ?").get(x);`].join("\n"),
        true,
      ],
      [
        // Was invisible to the old file scan: case-sensitive whole-name match.
        "the table named in upper case",
        [`db.query("DELETE FROM ${TABLE.toUpperCase()}").run();`].join("\n"),
        true,
      ],
      [
        // Also invisible: the source never assembles the name.
        "the table name built by concatenation",
        [`db.query("SELECT * FROM " + "pending_" + "approvals").all();`].join("\n"),
        true,
      ],
    ];
    for (const [label, src, expected] of cases) {
      expect(fileNamesTable(src), `file probe "${label}"`).toBe(expected);
    }
  });

  test("every exemption carries an argument, not just an entry", () => {
    // An exemption list whose reasons rot into "" is a deny-list that has
    // silently become an allow-list.
    for (const [fragment, reason] of Object.entries(UNSCOPED_BY_DESIGN)) {
      expect(reason.length, `exemption "${fragment}" has no argument`).toBeGreaterThan(30);
    }
  });
});
