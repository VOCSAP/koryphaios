import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findMatchingClose } from "./_braced-body";
import { DECK_ONLY_TOOLS, TOOLS } from "../shared/peers-session.ts";

// Sweeps the actual domain of role-write paths -- every db statement in
// broker.ts writing peers with role in its column list, and every MCP tool
// schema the peers session declares -- rather than enumerating scenarios, since
// there is no bounded list of scenarios that could self-promote a role, only a
// bounded list of write paths.
// Scoped to broker.ts and the peers session's tool registries only: blind to a
// peers write from another file, or to role migrating to a different table.

const BROKER_PATH = join(import.meta.dir, "..", "broker.ts");

/** LEG 1: no MCP tool inputSchema declares a `role` argument. */
export function findRoleArgumentInToolSchemas(
  tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>
): string[] {
  const failures: string[] = [];
  let schemaCount = 0;
  for (const tool of tools) {
    if (tool.inputSchema === undefined) continue;
    schemaCount++;
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    if (Object.hasOwn(properties, "role")) {
      failures.push(`tool "${tool.name}" declares a role-named inputSchema argument`);
    }
  }
  if (schemaCount === 0) {
    failures.push("no inputSchema found in the tool registries -- has the tool definition shape changed?");
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
  // Includes db.query(...) alongside prepare/run, since it is broker.ts's
  // dominant idiom and db.query(SQL).run(args) is still a fully functional
  // write shape.
  // Matches single-quoted SQL too, so a formatter flipping quote style can't
  // silently drop a statement from the sweep.
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

  // The federation writers copy a role another broker's handleRegister already
  // normalized (an upstream relaying a replica's peer, a replica mirroring a
  // remote one); they are the only other legitimate writers, and each must run
  // the value through normalizeRole itself so a hostile relay cannot plant an
  // unnormalized role. Their regions are located by their parameter list, not
  // by a signature-line brace: their signatures span several lines.
  const regions: { start: number; end: number }[] = [{ start: fnStart, end: fnEnd }];
  for (const needle of ["const federationSyncTx = db.transaction(", "function upsertMirror("]) {
    const at = src.indexOf(needle);
    if (at === -1) {
      failures.push(`${needle} not found in broker.ts -- has the federation writer been renamed?`);
      continue;
    }
    const paren = at + needle.length - 1;
    const paramsEnd = findMatchingClose(src, paren, "(", ")");
    const bodyStart = src.indexOf("{", needle.startsWith("const") ? paren : paramsEnd);
    const bodyEnd = findMatchingClose(src, bodyStart, "{", "}");
    const region = { start: bodyStart, end: bodyEnd };
    if (!/\bnormalizeRole\(/.test(src.slice(region.start, region.end))) {
      failures.push(`${needle} writes peers.role without normalizeRole(...)`);
    }
    regions.push(region);
  }
  const inAllowedRegion = (index: number): boolean =>
    regions.some((r) => index >= r.start && index <= r.end);

  // Matches 'INSERT OR IGNORE/REPLACE INTO' as well as plain 'INSERT INTO':
  // broker.ts's own sentinel-row seed uses that form.
  const roleWritingStatements = findSqlStatements(src).filter(
    (s) => /\b(?:insert(?:\s+or\s+\w+)?\s+into|update)\s+peers\b/i.test(s.sql) && /\brole\b/.test(s.sql)
  );
  if (roleWritingStatements.length === 0) {
    failures.push("no INSERT/UPDATE on peers mentioning `role` found at all -- has the write path moved?");
  }

  for (const stmt of roleWritingStatements) {
    if (stmt.varName === null) {
      // Inline db.run(...): the write call IS the declaration site.
      if (!inAllowedRegion(stmt.declIndex)) {
        failures.push(`inline db.run(...) writing peers.role at offset ${stmt.declIndex} is outside handleRegister and the federation writers`);
      }
      continue;
    }
    // Named prepared statement: sweep the WHOLE file for its call sites.
    const callRe = new RegExp(`\\b${stmt.varName}\\.run\\(`, "g");
    let callMatch: RegExpExecArray | null;
    let callSiteCount = 0;
    while ((callMatch = callRe.exec(src))) {
      callSiteCount++;
      if (!inAllowedRegion(callMatch.index)) {
        failures.push(
          `${stmt.varName}.run(...) (writes peers.role) called at offset ${callMatch.index}, outside handleRegister and the federation writers`
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

test("LEG 1: no MCP tool inputSchema declared by the peers session or the operator family declares a role argument", () => {
  const failures = findRoleArgumentInToolSchemas([...TOOLS, ...DECK_ONLY_TOOLS]);
  expect(failures).toEqual([]);
});

test("LEG 1 detector: a role property is reported by tool name and an empty registry is a failure, not a pass", () => {
  const withRole = { name: "bad_tool", inputSchema: { type: "object", properties: { role: { type: "string" } } } };
  expect(findRoleArgumentInToolSchemas([withRole])).toEqual(['tool "bad_tool" declares a role-named inputSchema argument']);
  expect(findRoleArgumentInToolSchemas([]), "an empty registry must not read as a clean sweep").not.toEqual([]);
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
