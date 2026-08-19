// spec_67d0b267 -- card 1def56da, DESIGN-APPROVAL-SCOPE.md D4.
//
// WHAT THE TYPE CANNOT DO, AND THEREFORE WHAT THIS FILE IS FOR.
// shared/approval-scope.ts makes it impossible to build an identity clause on
// `pending_approvals` without a scope: `approvalWhere` takes one, and no
// exported function turns an `ApprovalIdentity` into one. That closes forgetting
// the scope WHEN YOU GO THROUGH THE MODULE. It cannot close writing SQL that
// bypasses the module entirely -- a module boundary is not a language boundary,
// and the brief says so rather than pretending otherwise.
//
// This scan is that missing half. Its polarity is the point: the default is
// REFUSE. A new statement touching the table fails until someone writes down
// why it may be unscoped, and a new FILE touching the table fails outright.
// The list below is therefore not the "watched" set -- everything is watched --
// it is the set of statements whose lack of a scope has been argued.
//
// NAMED `desktop-*` so the CI glob at .github/workflows/desktop-build.yml:79
// collects it. That is not decoration: measured 2026-08-19, the four suites
// covering approvals (1409 lines) match none of the ten globs, so without a
// deliberate name this guard would run on one developer's machine and nowhere
// else -- the exact failure DESIGN-NOTIFY-DECIDER.md §5.4 describes for the
// sibling guard.

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TABLE = "pending_approvals";

/** The composer whose presence proves a statement is scoped. */
const SCOPE_MARKERS = ["${where.sql}", "stamped.columns"];

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
  "DELETE FROM pending_approvals": "Retention purge. Same reason as the sweep above.",
  "readonly [SCOPE_BRAND]":
    "Not SQL. The table name is the BRAND of the opaque scope type, which is deliberately named after the thing it authorises so a reader knows what it unlocks.",
  "readonly [STAMP_BRAND]":
    "Not SQL. Same reason as the scope brand above: the stamp is branded with the table its columns are written into.",
  "[approvalId]":
    "The read INSIDE scopeForAnsweredRow, the gateway path's only SQL. It is what PRODUCES a scope from a row, so scoping it would require the answer it exists to produce. It is safe for the reason the old exported form was not: the caller supplies an id and nothing else, so it cannot name its own operator or project.",

  // A GATEWAY EXEMPTION USED TO SIT HERE, `get(answer.approvalId)`, for
  // `channelHost.onAnswer`'s pre-authorisation read. It is GONE because the read
  // is gone: review round 2 moved it inside shared/approval-scope.ts
  // (`scopeForAnsweredRow`), so the handler performs no SQL on this table at
  // all. Deleted rather than left dormant on purpose -- an exemption that
  // protects no site is a false pointer in the making, and this one also
  // carried the justification of a mechanism (`scopeForOwnedRow`) that no
  // longer exists. The next reader would have taken it for a live derogation
  // and copied it.
  //
  // Its history is worth one line, because the trap it fell into is generic:
  // written first as the bare SQL string `"SELECT * FROM pending_approvals
  // WHERE id = ?"`, it excused an unscoped read fabricated in a COMPLETELY
  // DIFFERENT handler, and the scan stayed 4/4 green while the broker suite
  // went red. A generic fragment excuses a SHAPE, not a site. Any exemption
  // added below must be anchored on something unique to the one place it
  // covers.
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
 * The window a statement occupies, ending at the STATEMENT'S OWN end rather
 * than after a fixed number of lines.
 *
 * MEASURED DEFECT, review round 2: a fixed four-line window let an UNSCOPED
 * read placed directly above a scoped one pass, because the NEIGHBOUR's
 * `${where.sql}` fell inside the window. The scan then vouched for a statement
 * on the strength of a different statement's clause. The end is found by
 * balancing parentheses from the `db` call that opens the statement, which is
 * how the multi-line template literals in broker.ts are actually delimited --
 * a line count is not a syntactic fact, and this is why it could be fooled.
 */
function statementAt(lines: string[], start: number): string {
  let depth = 0;
  let seen = false;
  const parts: string[] = [];
  for (let i = start; i < lines.length && i < start + 40; i++) {
    const line = lines[i] ?? "";
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
 * Strip a line-comment tail before looking for markers.
 *
 * B3, MEASURED: the comment skip applied only to the line where the table name
 * appeared, never to the CONTENTS of the window. So an unscoped read whose
 * trailing comment merely MENTIONED `${where.sql}` was vouched for by its own
 * prose. Code and commentary have to be told apart wherever a marker is looked
 * for, not only where the offence is detected.
 *
 * Naive on purpose: a `//` inside a string literal (a URL) would truncate the
 * line early. That costs a false POSITIVE at worst, which is the fail-closed
 * direction, and no statement in the scanned files contains one.
 */
function codeOnly(line: string): string {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
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
    // D2, MEASURED: matched case-sensitively and as a whole word, so
    // `PENDING_APPROVALS` and `"pending_" + "approvals"` both slipped through.
    // Lower-casing closes the first; looking for the HALVES closes the second,
    // since a scan that only knows the assembled name cannot see a name the
    // source never assembles.
    const lower = codeOnly(line).toLowerCase();
    const names = lower.includes(TABLE) || (lower.includes("pending_") && lower.includes("approvals"));
    if (!names) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const window = statementAt(lines, i)
      .split("\n")
      .map(codeOnly)
      .join("\n");
    if (SCOPE_MARKERS.some((m) => window.includes(m))) continue;
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
      if (readFileSync(file, "utf-8").includes(TABLE)) offenders.push(rel);
    }
    expect(
      offenders,
      `These files reach the approvals table without going through shared/approval-scope.ts. ` +
        `If that is deliberate, add the file to ALLOWED_FILES here AND say why in its own comment; ` +
        `if it is not, route the query through approvalWhere(scope).`
    ).toEqual([]);
  });

  test("every statement in the SQL-bearing files is scoped, or argued in writing", () => {
    // C1, MEASURED: this audit used to read `broker.ts` ALONE. Since review
    // round 2, `shared/approval-scope.ts` performs its own SELECT on the
    // protected table (`scopeForAnsweredRow`), so the file with the best reason
    // to write there was the one file the guard never looked at -- an unscoped
    // read fabricated inside it left the scan at 4 pass. Both are already in
    // ALLOWED_FILES, so there was nothing to arbitrate, only to loop over.
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
   * The probes call `offendersIn`, the SAME function the audit above calls --
   * not a copy of its logic. That is the whole correction of A1: previously
   * this was a second loop body, so the audit could go blind while every probe
   * stayed green.
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
        "the legitimate scoped form",
        [`const rows = db`, `  .query(\`SELECT * FROM ${TABLE} WHERE \${where.sql}\`)`, `  .all(...where.params);`].join("\n"),
        true,
      ],
    ];
    for (const [label, src, expected] of cases) {
      expect(clean(src), `probe "${label}"`).toBe(expected);
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
