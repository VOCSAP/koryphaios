import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody, extractBracketedBody, findMatchingClose } from "./_braced-body";

// Card a2f61172, PARTIE 2 of the post-reversal rewrite: the central guarantee
// on `role` is no longer a per-scenario write-once rule (see
// tests/broker-register-role.test.ts), it is a DOMAIN property --
//   NO PATH REACHABLE BY AN AGENT MAY SET OR CHANGE A ROLE, OTHER THAN
//   /register's handleRegister (broker.ts), which alone derives it from a
//   TRANSPORT value (body.role, ultimately CLAUDE_PEERS_ROLE) via
//   normalizeRole().
// This is the only thing standing between an agent and self-promoting its
// own role, so a scenario-based test ("call tool X, assert role unchanged")
// cannot cover it -- there is no bounded list of scenarios, only a bounded
// list of WRITE PATHS. This file sweeps the actual DOMAIN of write paths
// instead of enumerating tools or SQL statements by name, so it keeps
// covering the domain as it grows:
//
//   LEG 1 (server.ts): no MCP tool's inputSchema declares a `role`-named
//   argument, found by parsing the REAL `TOOLS` array structurally (bracket-
//   and brace-balanced), not by checking a hand-picked list of tool names.
//   Deliberately STRICTER than "wired to a write": this repo is small enough
//   that a `role` argument appearing in a schema AT ALL is itself the defect
//   worth catching, before anyone gets to wire it further.
//
//   LEG 2 (broker.ts, the load-bearing leg): every db.prepare/db.run SQL
//   statement that writes `peers` (INSERT INTO peers / UPDATE peers SET) AND
//   whose column list/SET clause contains `role` -- found by regex-sweeping
//   the WHOLE FILE for db.prepare(...)/db.run(...) calls, not by checking
//   `insertPeer`/`updateActiveOnRegister` by name -- must have EVERY actual
//   `.run(...)` call site lexically INSIDE handleRegister's function body
//   (brace-balanced containment, not a line-number guess). A statement with
//   zero found call sites also fails: an unused role-writing statement is a
//   live capability nobody is watching.
//
//   LEG 3 (broker.ts, corroborating only): `body.role` is read in exactly
//   one place. Declared LIMIT: this is a naming-dependent proxy (a future
//   handler destructuring its request body under a different identifier
//   would silently miss it) -- LEG 2 is what actually enforces the
//   guarantee; LEG 3 only corroborates the specific mechanism in place today.
//
// HONEST SCOPE LIMIT: this sweep covers broker.ts (the only place `peers`
// rows are written) and server.ts's MCP tool surface (the only agent-facing
// entry point into the broker). It does NOT sweep desktop/'s IPC channels
// (DeckApi) -- an agent does not call those directly, and the reviewer's own
// three measured facts this file reuses were scoped to broker.ts/server.ts.
//
// SECOND HONEST SCOPE LIMIT (review finding, 2026-08-24): LEG 2 reads ONE
// hardcoded file, BROKER_PATH. It is blind to a `peers` write from a NEW
// file -- not hypothetical: tests/migrate-project-key-case.test.ts already
// exercises scripts/migrate-project-key-case.ts, which does its own
// `INSERT INTO peers` outside broker.ts entirely. It is equally blind to
// `role` migrating to a different TABLE (`peer_sessions`, a future `roles`
// table): the SQL filter is anchored on the literal token `peers`.
//
// Named role-domain-sweep.test.ts, deliberately NOT broker-role-...: read
// scripts/pure-module-partition.ts's EXEMPTIONS table before naming this
// file and found `familyPrefixes: { "broker-": ..., "server-": ... }` is a
// bare filename `.startsWith(prefix)` check with zero content awareness --
// and that module's own header states the exempted families are "not run in
// CI at all today" (N1, pre-existing). This file spawns no daemon and binds
// no port (pure text sweep over two source files), so it belongs in the
// default "clean, runs in the shared pure-modules process" bucket; a
// `broker-`-prefixed name would have silently dropped it out of CI exactly
// like the trap this repo's own CLAUDE.md warns about for CI globs/deny-
// lists, and nothing would have caught that until someone went looking.

const BROKER_PATH = join(import.meta.dir, "..", "broker.ts");
const SERVER_PATH = join(import.meta.dir, "..", "server.ts");

// extractBracedBody/extractBracketedBody/findMatchingClose all now live in
// tests/_braced-body.ts (card 9e450573 Lot A + Lot B dedup) -- imported
// above. Nothing local left in this file.

/** LEG 1: no MCP tool inputSchema in server.ts declares a `role` argument. */
export function findRoleArgumentInToolSchemas(src: string): string[] {
  const failures: string[] = [];
  const toolsMatch = /const TOOLS\s*=\s*\[/.exec(src);
  if (!toolsMatch) {
    return ["const TOOLS = [ ... ] not found in server.ts -- has the tool registry been renamed?"];
  }
  const toolsOpenIdx = toolsMatch.index + toolsMatch[0].length - 1;
  const toolsBody = extractBracketedBody(src, toolsOpenIdx);

  const inputSchemaRe = /inputSchema:\s*\{/g;
  let m: RegExpExecArray | null;
  let schemaCount = 0;
  while ((m = inputSchemaRe.exec(toolsBody))) {
    schemaCount++;
    const schemaOpenIdx = m.index + m[0].length - 1;
    const schemaBody = extractBracedBody(toolsBody, schemaOpenIdx);
    // Best-effort tool name for a legible failure message -- look backward
    // from this inputSchema to the nearest preceding `name: "..."`.
    const before = toolsBody.slice(0, m.index);
    const nameMatch = /name:\s*"([^"]+)"(?![\s\S]*name:\s*")/.exec(before);
    const toolName = nameMatch ? nameMatch[1] : `<tool #${schemaCount}>`;

    const propsMatch = /properties:\s*\{/.exec(schemaBody);
    if (!propsMatch) continue; // an empty {} properties (e.g. whoami) has nothing to check
    const propsOpenIdx = propsMatch.index + propsMatch[0].length - 1;
    const propsBody = extractBracedBody(schemaBody, propsOpenIdx);
    if (/(^|\n)\s*role\s*:\s*\{/.test(propsBody)) {
      failures.push(`tool "${toolName}" declares a role-named inputSchema argument`);
    }
  }
  if (schemaCount === 0) {
    failures.push("no inputSchema found inside TOOLS -- has the tool definition shape changed?");
  }
  return failures;
}

interface SqlStatement {
  varName: string | null; // null for an inline db.run(...) with no separate .prepare
  declIndex: number; // index into src where this statement's db.prepare/db.run call starts
  sql: string;
}

/** Every db.prepare(...)/db.run(...) call in `src`, with its raw SQL text. */
function findSqlStatements(src: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  // `db.query(...)` is included alongside prepare/run -- review finding
  // (2026-08-24): db.query(...) is the DOMINANT idiom in broker.ts (35
  // occurrences), most reading, but `db.query(SQL).run(args)` is a fully
  // functional write shape already practiced live in this repo
  // (tests/broker-operator-inbox.test.ts:532), and was invisible to a sweep
  // that only knew prepare/run. Single-quoted SQL strings ('[^']*') are
  // included too -- none exist in broker.ts today, but a formatter flipping
  // quote style would otherwise silently drop a statement from the sweep.
  const re = /(?:const\s+(\w+)\s*=\s*)?db\.(?:prepare|run|query)\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[2]!;
    const sql = raw.slice(1, -1);
    statements.push({ varName: m[1] ?? null, declIndex: m.index, sql });
  }
  return statements;
}

/**
 * LEG 2 (load-bearing): every peers-writing, role-touching SQL statement's
 * ACTUAL .run(...) call sites must all be lexically inside handleRegister.
 */
export function findRoleWritesOutsideHandleRegister(src: string): string[] {
  const failures: string[] = [];

  const fnKeywordMatch = /function handleRegister\(/.exec(src);
  if (!fnKeywordMatch) {
    return ["function handleRegister(...) not found in broker.ts -- has it been renamed?"];
  }
  // handleRegister's return type is a union containing an inline object
  // literal (`RegisterResponse | { error: string; status: number }`), so a
  // naive `[^{]*\{` match stops at THAT brace, not the real function body --
  // measured live: it silently truncated the body to ~30 chars and flagged
  // every real call site as "outside". The body-opening brace is instead the
  // LAST `{` on the signature's own source line (true for this codebase's
  // one-line-signature formatting), which is immune to any number of braces
  // inside the return type as long as they stay on that same line.
  const sigLineEnd = src.indexOf("\n", fnKeywordMatch.index);
  const sigLine = src.slice(fnKeywordMatch.index, sigLineEnd === -1 ? src.length : sigLineEnd);
  const lastBraceInSigLine = sigLine.lastIndexOf("{");
  if (lastBraceInSigLine === -1) {
    return ["handleRegister's signature line has no opening brace -- is the body on a separate line now?"];
  }
  const fnStart = fnKeywordMatch.index + lastBraceInSigLine;
  const fnEnd = findMatchingClose(src, fnStart, "{", "}");

  // `insert\s+into` alone misses "INSERT OR IGNORE INTO peers" / "INSERT OR
  // REPLACE INTO peers" -- review finding (2026-08-24): broker.ts:469
  // already contains exactly that form (the sentinel-row seed), so this
  // wasn't a hypothetical, it was a statement in the very file being swept.
  const roleWritingStatements = findSqlStatements(src).filter(
    (s) => /\b(?:insert(?:\s+or\s+\w+)?\s+into|update)\s+peers\b/i.test(s.sql) && /\brole\b/.test(s.sql)
  );
  if (roleWritingStatements.length === 0) {
    failures.push("no INSERT/UPDATE on peers mentioning `role` found at all -- has the write path moved?");
  }

  for (const stmt of roleWritingStatements) {
    if (stmt.varName === null) {
      // Inline db.run(...): the write call IS the declaration site.
      if (stmt.declIndex < fnStart || stmt.declIndex > fnEnd) {
        failures.push(`inline db.run(...) writing peers.role at offset ${stmt.declIndex} is outside handleRegister`);
      }
      continue;
    }
    // Named prepared statement: sweep the WHOLE file for its call sites.
    const callRe = new RegExp(`\\b${stmt.varName}\\.run\\(`, "g");
    let callMatch: RegExpExecArray | null;
    let callSiteCount = 0;
    while ((callMatch = callRe.exec(src))) {
      callSiteCount++;
      if (callMatch.index < fnStart || callMatch.index > fnEnd) {
        failures.push(
          `${stmt.varName}.run(...) (writes peers.role) called at offset ${callMatch.index}, outside handleRegister`
        );
      }
    }
    if (callSiteCount === 0) {
      failures.push(`${stmt.varName} writes peers.role but has no .run(...) call site anywhere in the file`);
    }
  }
  return failures;
}

/** LEG 3 (corroborating, naming-dependent -- see file header for its limit). */
export function countBodyRoleReads(src: string): number {
  return (src.match(/\bbody\.role\b/g) ?? []).length;
}

test("LEG 1: no MCP tool inputSchema in server.ts declares a role argument", () => {
  const src = readFileSync(SERVER_PATH, "utf-8");
  const failures = findRoleArgumentInToolSchemas(src);
  expect(failures).toEqual([]);
});

test("LEG 2: every peers-writing SQL statement touching role is called only from handleRegister", () => {
  const src = readFileSync(BROKER_PATH, "utf-8");
  const failures = findRoleWritesOutsideHandleRegister(src);
  expect(failures).toEqual([]);
});

test("LEG 3 (corroborating): body.role is read in exactly one place in broker.ts", () => {
  const src = readFileSync(BROKER_PATH, "utf-8");
  expect(countBodyRoleReads(src)).toBe(1);
});
