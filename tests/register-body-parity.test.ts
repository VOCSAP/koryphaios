// Compares the two /register bodies as sets rather than checking one site: a
// key added to or dropped from a single site is caught by the symmetric
// difference, and a key dropped from both sites (invisible to that difference)
// is caught by requiring every identity key present in both.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVER_SRC = readFileSync(resolve(import.meta.dir, "..", "server.ts"), "utf-8");

/**
 * Keys BOTH /register bodies must carry. `claude_cli_pid` is deliberately
 * absent: it is a property of the BOOT process (process.ppid of server.ts) and
 * its one-sided presence is the documented, intended divergence below.
 */
const REQUIRED_IN_BOTH = [
  "pid",
  "cwd",
  "git_root",
  "tty",
  "summary",
  "host",
  "client_pid",
  "project_key",
  "group_id",
  "group_secret_hash",
  "role",
  "desk_session",
  "cc_session_id",
] as const;

/** The ONE key allowed to appear in a single body. Grows only by decision. */
const ALLOWED_DIVERGENCE = ["claude_cli_pid"];

/**
 * Extract the top-level key names of every object literal passed as the second
 * argument of a `"/register"` call, by brace balancing from the `{` that
 * follows the route string. Comment-only lines are dropped first so a
 * commented-out `// role: ...` can never be counted as a live key.
 */
function registerBodyKeySets(src: string): Set<string>[] {
  const sets: Set<string>[] = [];
  const marker = '"/register"';
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    const open = src.indexOf("{", from);
    if (open === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    const body = src.slice(open + 1, end);
    const keys = new Set<string>();
    let depthInBody = 0;
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("//")) continue;
      if (depthInBody === 0) {
        // Three forms, and missing one is not hypothetical: the boot body
        // writes `tty,` and `host,` as SHORTHAND, and a `key:`-only regex
        // found 11 keys there instead of 13 -- an extractor returning a
        // SUBSET, the fail-open this file's second assertion exists to catch.
        //
        // The `else throw` is the part that actually closes the family. Adding
        // patterns one at a time only ever covers the forms someone thought
        // of: a review measured that a QUOTED key and a SPREAD both slipped
        // through silently, hiding a one-sided ADDITION. Any line no
        // expression consumes must THROW rather than be ignored, so a computed
        // key or any future syntax breaks the test loudly instead of shrinking
        // what it protects.
        const explicit = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
        const quoted = /^["']([A-Za-z_][A-Za-z0-9_]*)["']\s*:/.exec(line);
        const shorthand = /^([A-Za-z_][A-Za-z0-9_]*)\s*,?$/.exec(line);
        const name = explicit?.[1] ?? quoted?.[1] ?? shorthand?.[1];
        if (name) keys.add(name);
        else if (line && !line.startsWith("}") && !line.startsWith("]")) {
          throw new Error(
            `register body line not recognised as a property, so the extractor would silently ignore it: ${line}`
          );
        }
      }
      for (const ch of line) {
        if (ch === "{" || ch === "[") depthInBody += 1;
        else if (ch === "}" || ch === "]") depthInBody -= 1;
      }
    }
    sets.push(keys);
    from = end;
  }
  return sets;
}

test("the extractor really found BOTH /register bodies, each with a real key set", () => {
  // Guard on the INSTRUMENT before trusting its verdict: two EMPTY sets are
  // trivially equal, so a silently broken extractor would make every parity
  // assertion below pass while proving nothing.
  const sets = registerBodyKeySets(SERVER_SRC);
  expect(sets).toHaveLength(2);
  for (const s of sets) expect(s.size).toBeGreaterThanOrEqual(REQUIRED_IN_BOTH.length);
});

test("both /register bodies in server.ts carry every required identity key", () => {
  const [bootOrSwitchA, bootOrSwitchB] = registerBodyKeySets(SERVER_SRC);
  for (const key of REQUIRED_IN_BOTH) {
    expect({ key, inFirstBody: bootOrSwitchA?.has(key) }).toEqual({ key, inFirstBody: true });
    expect({ key, inSecondBody: bootOrSwitchB?.has(key) }).toEqual({ key, inSecondBody: true });
  }
});

test("the two /register bodies diverge on EXACTLY the one documented key", () => {
  const [a, b] = registerBodyKeySets(SERVER_SRC);
  const first = a ?? new Set<string>();
  const second = b ?? new Set<string>();
  const onlyInFirst = [...first].filter((k) => !second.has(k));
  const onlyInSecond = [...second].filter((k) => !first.has(k));
  expect([...onlyInFirst, ...onlyInSecond].sort()).toEqual(ALLOWED_DIVERGENCE);
});
