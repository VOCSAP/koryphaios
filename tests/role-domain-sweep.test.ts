import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody, extractBracketedBody, findMatchingClose } from "./_braced-body";

// Sweeps the actual domain of role-write paths -- every db statement in
// broker.ts writing peers with role in its column list, and every MCP tool
// schema in server.ts -- rather than enumerating scenarios, since there is no
// bounded list of scenarios that could self-promote a role, only a bounded list
// of write paths.
// Scoped to broker.ts and server.ts only: blind to a peers write from another
// file, or to role migrating to a different table.

const BROKER_PATH = join(import.meta.dir, "..", "broker.ts");
const SERVER_PATH = join(import.meta.dir, "..", "server.ts");

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
