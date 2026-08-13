// Guards the forced local mirror of the Approval wire shape: desktop's
// tsconfig.web.json has an explicit file list that cannot reach outside
// desktop/ (measured by team-lead: reinstating the direct import and
// deleting the mirror makes `tsc -p desktop/tsconfig.web.json` fail with
// `error TS6307: File '.../shared/approval.ts' is not listed within the
// file list of project '.../desktop/tsconfig.web.json'` -- the node half of
// the typecheck passes the same import, which is why approval-auth.ts and
// roadmap-service.ts already import the root shared/ from desktop/src/main:
// the boundary only closes on the web side). desktop/src/shared/types.ts
// therefore carries its own copy of Approval, ApprovalOrigin and the five
// associated type aliases, with a header comment telling the reader to
// resync by hand -- a guarantee asserted in prose with nothing wired to it,
// which is exactly the pattern CLAUDE.md's "a comment that asserts a
// guarantee must be wired to it" rule calls out. spec_35136ce1.
//
// Coverage requirement (CLAUDE.md's gating-coverage rule): the dangerous
// direction is the ROOT source GROWING a field the mirror doesn't have --
// that's how a wire shape evolves in practice, the Deck still compiles, the
// existing tests still pass, and the mirror lies silently until a live
// operator hits a field that isn't there. A comparison that only checks
// "everything in the mirror exists in the root" does not see this. Every
// check below runs in BOTH directions on purpose.
//
// WHAT THIS DOES NOT CATCH, stated rather than assumed:
//  - A field or union member renamed IDENTICALLY on both sides in the same
//    edit produces two shapes that still match -- this guard cannot see a
//    coordinated rename, only a one-sided edit.
//  - Field TYPE comparison is whitespace-normalized TEXT equality, not a
//    real type-level diff: `Array<string>` vs `string[]` (semantically the
//    same) would be flagged as a violation, and a reordered union written
//    differently (`null | ApprovalVia` vs `ApprovalVia | null`) would too.
//    Both are false positives that fail CLOSED (a human has to look), which
//    this repo's conventions treat as the safe failure mode -- but they are
//    real limits of this method, not edge cases it handles.
//  - Only the 7 declarations named in DECLARATIONS below are tracked. A
//    field whose type references some OTHER shared type not in that list
//    (none exist today) would not have that referenced type's own shape
//    checked.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const ROOT_TYPES_TS = join(REPO_ROOT, "shared", "types.ts");
const MIRROR_TYPES_TS = join(REPO_ROOT, "desktop", "src", "shared", "types.ts");

const UNION_NAMES = [
  "ApprovalStatus",
  "ApprovalKind",
  "ApprovalVia",
  "ApprovalReplyRoute",
  "ApprovalAnswerKind",
] as const;
const INTERFACE_NAMES = ["ApprovalOrigin", "Approval"] as const;

// Strips `//` line comments and `/* */` block comments, quote-aware (a
// union member is itself a quoted string, e.g. "expired_notif", and must
// survive untouched even though it contains no comment-like sequences today
// -- defensive, same shape as the JSONC stripper in
// tests/desktop-tsconfig-flags.test.ts).
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `export type Name = "a" | 'b' | ...` -> sorted literal members. undefined if the declaration is absent entirely. */
function extractUnion(cleanedSrc: string, name: string): string[] | undefined {
  const m = cleanedSrc.match(new RegExp(`export type ${name}\\s*=\\s*([^\\n;]+)`));
  if (!m) return undefined;
  return [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((mm) => mm[1]!).sort();
}

/** `export interface Name { field?: Type ... }` -> { "field" | "field?": normalizedTypeText }. undefined if absent. */
function extractInterface(cleanedSrc: string, name: string): Record<string, string> | undefined {
  const startMatch = cleanedSrc.match(new RegExp(`export interface ${name}\\s*\\{`));
  if (!startMatch) return undefined;
  const start = startMatch.index! + startMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < cleanedSrc.length && depth > 0) {
    if (cleanedSrc[i] === "{") depth++;
    else if (cleanedSrc[i] === "}") depth--;
    i++;
  }
  const body = cleanedSrc.slice(start, i - 1);
  const fields: Record<string, string> = {};
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fm = line.match(/^(\w+)(\??):\s*(.+?);?$/);
    if (!fm) continue;
    fields[fm[1]! + fm[2]!] = fm[3]!.trim().replace(/\s+/g, " ");
  }
  return fields;
}

/**
 * Compares the 7 tracked Approval-shape declarations between a "root" source
 * and a "mirror" source. Every check is bidirectional (root-only AND
 * mirror-only), per the coverage requirement in the header comment.
 */
function diffApprovalShapes(rootSrc: string, mirrorSrc: string): string[] {
  const violations: string[] = [];
  const root = stripComments(rootSrc);
  const mirror = stripComments(mirrorSrc);

  for (const name of UNION_NAMES) {
    const r = extractUnion(root, name);
    const m = extractUnion(mirror, name);
    if (r === undefined || m === undefined) {
      violations.push(`${name}: declaration missing from ${r === undefined ? "root" : "mirror"}`);
      continue;
    }
    const rSet = new Set(r);
    const mSet = new Set(m);
    for (const member of r) if (!mSet.has(member)) violations.push(`${name}: root has member "${member}" missing from mirror`);
    for (const member of m) if (!rSet.has(member)) violations.push(`${name}: mirror has member "${member}" missing from root`);
  }

  for (const name of INTERFACE_NAMES) {
    const r = extractInterface(root, name);
    const m = extractInterface(mirror, name);
    if (r === undefined || m === undefined) {
      violations.push(`${name}: declaration missing from ${r === undefined ? "root" : "mirror"}`);
      continue;
    }
    for (const [field, type] of Object.entries(r)) {
      if (!(field in m)) {
        violations.push(`${name}.${field}: present in root, missing from mirror`);
      } else if (m[field] !== type) {
        violations.push(`${name}.${field}: type differs (root="${type}" mirror="${m[field]}")`);
      }
    }
    for (const field of Object.keys(m)) {
      if (!(field in r)) violations.push(`${name}.${field}: present in mirror, missing from root`);
    }
  }

  return violations;
}

// ----- real-repo check ----------------------------------------------------

test("Approval wire shape: repo-root shared/types.ts and desktop/src/shared/types.ts agree today", () => {
  const rootSrc = readFileSync(ROOT_TYPES_TS, "utf-8");
  const mirrorSrc = readFileSync(MIRROR_TYPES_TS, "utf-8");
  expect(diffApprovalShapes(rootSrc, mirrorSrc)).toEqual([]);
});

test("running the real-file comparison twice is idempotent (byte-identical violations both times)", () => {
  const rootSrc = readFileSync(ROOT_TYPES_TS, "utf-8");
  const mirrorSrc = readFileSync(MIRROR_TYPES_TS, "utf-8");
  const first = diffApprovalShapes(rootSrc, mirrorSrc);
  const second = diffApprovalShapes(rootSrc, mirrorSrc);
  expect(second).toEqual(first);
});

// ----- fixture-backed positive/negative controls --------------------------
//
// Small synthetic sources, not the real files, exercising diffApprovalShapes
// directly -- the same function the real-repo test above uses, so the two
// paths cannot drift (same pattern as auditConfigs() in
// tests/desktop-tsconfig-flags.test.ts).

function fixtureSource(overrides: { approvalKindExtra?: string; originExtra?: string } = {}): string {
  return `
export type ApprovalKind = "permission" | "question" | "plan"${overrides.approvalKindExtra ?? ""}
export type ApprovalStatus = "pending" | "answered" | "expired_notif" | "abandoned"
export type ApprovalVia = "deck" | "telegram" | "discord" | "ntfy"
export type ApprovalReplyRoute = "channel" | "pty"
export type ApprovalAnswerKind = "allow" | "deny" | "text"

export interface ApprovalOrigin {
  host: string
  os_user_hash: string
  project_key: string
  group_id: string
  from_peer: string
  session_ref: string
  tile_ref: string${overrides.originExtra ?? ""}
}

export interface Approval {
  id: string
  operator_id: string
  origin: ApprovalOrigin
  kind: ApprovalKind
  status: ApprovalStatus
  reply_route: ApprovalReplyRoute
  answered_via: ApprovalVia | null
  answer_kind: ApprovalAnswerKind | null
}
`;
}

test("fixture positive control: two identical sources produce zero violations", () => {
  const src = fixtureSource();
  expect(diffApprovalShapes(src, src)).toEqual([]);
});

test("fixture: a field ADDED to the root and missing from the mirror is caught (the growth/fail-open case)", () => {
  const root = fixtureSource({ originExtra: "\n  new_field: string" });
  const mirror = fixtureSource();
  const violations = diffApprovalShapes(root, mirror);
  expect(violations).toContain("ApprovalOrigin.new_field: present in root, missing from mirror");
});

test("fixture: a field REMOVED from the root (present only in the mirror) is caught", () => {
  const root = fixtureSource();
  const mirror = fixtureSource({ originExtra: "\n  stale_field: string" });
  const violations = diffApprovalShapes(root, mirror);
  expect(violations).toContain("ApprovalOrigin.stale_field: present in mirror, missing from root");
});

test("fixture: a union member ADDED to the root and missing from the mirror is caught, for a non-interface alias", () => {
  const root = fixtureSource({ approvalKindExtra: ' | "escalation"' });
  const mirror = fixtureSource();
  const violations = diffApprovalShapes(root, mirror);
  expect(violations).toContain('ApprovalKind: root has member "escalation" missing from mirror');
});

test("fixture: a same-named field with a different type text is caught", () => {
  const root = fixtureSource();
  const mirror = fixtureSource().replace("tile_ref: string", "tile_ref: string | null");
  const violations = diffApprovalShapes(root, mirror);
  expect(violations).toContain('ApprovalOrigin.tile_ref: type differs (root="string" mirror="string | null")');
});

test("fixture: a declaration entirely absent from the mirror is caught, not silently treated as equal", () => {
  const root = fixtureSource();
  const mirror = fixtureSource().replace(
    "export interface ApprovalOrigin {",
    "export interface ApprovalOriginRenamed {"
  );
  const violations = diffApprovalShapes(root, mirror);
  expect(violations).toContain("ApprovalOrigin: declaration missing from mirror");
});

test("fixture: incidental whitespace in a field's type text is NOT flagged (normalized before comparing)", () => {
  const root = fixtureSource();
  const mirror = fixtureSource().replace("answered_via: ApprovalVia | null", "answered_via: ApprovalVia  |   null");
  expect(diffApprovalShapes(root, mirror)).toEqual([]);
});

test("fixture: a trailing // comment and a leading doc comment around fields do not corrupt extraction", () => {
  const root = fixtureSource().replace(
    "tile_ref: string",
    "// UNTRUSTED routing metadata, see header\n  tile_ref: string // ISO timestamp style trailing comment"
  );
  const mirror = fixtureSource().replace(
    "tile_ref: string",
    "/**\n   * Tile ref, doc comment above the field\n   */\n  tile_ref: string"
  );
  expect(diffApprovalShapes(root, mirror)).toEqual([]);
});
