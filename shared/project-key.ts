// Card 6aa32af4: single derivation for the project_key a session uses, so
// peer registration (/register's request body) and roadmap card scoping
// (server.ts's roadmapProjectKey()) can never diverge again. Before this,
// they were two independent derivations of the same identity:
// computeProjectKey() (this file's sibling, summarize.ts) returns null on
// any git-remote failure with no fallback applied at that layer, while only
// the roadmap-scoping call site added a local:<hash> fallback. A peer with
// no git remote therefore registered project_key=null in the peers table
// while its own roadmap cards were scoped to a non-null local:<hash> --
// and releaseStaleLocks' NULL-safe `IS` comparison (card fc444eda) then
// read "different key" as "not this peer's card", sweeping a live peer's
// own lock as owner-gone within one grace period.
//
// Pure module, no I/O -- same shape as shared/roadmap-lock.ts (card
// e7b364dc Part B) and for the same reason: server.ts has zero exports and
// runs main() unconditionally at module scope, so it cannot be imported
// directly for a unit test.

import { createHash } from "node:crypto";

/**
 * Normalize a git remote URL into a stable cross-PC key, e.g.
 *   git@github.com:vocsap/koryphaios.git     -> github.com/vocsap/koryphaios
 *   https://github.com/vocsap/koryphaios.git -> github.com/vocsap/koryphaios
 *   ssh://git@gitlab.com:2222/group/proj.git -> gitlab.com/group/proj
 *
 * Card 6aa32af4 (2nd review round): this used to be duplicated verbatim in
 * shared/summarize.ts and desktop/src/main/roadmap-service.ts. Since
 * resolveProjectKey() below returns a non-empty remote key AS-IS (no
 * further transform), that duplicate WAS the entire derivation whenever a
 * repo has a remote -- the majority case -- so consolidating only
 * resolveProjectKey()'s local:<hash> fallback branch left the actual
 * divergence risk in place. Pure, node:crypto/regex only: safe to import
 * from both the Bun runtime (server.ts, shared/summarize.ts) and the
 * Electron/Node desktop/ build (roadmap-service.ts), same as
 * resolveProjectKey() itself. Both call sites re-export this symbol so
 * existing `from "./summarize.ts"` / `from "./roadmap-service.ts"` imports
 * keep working.
 */
export function normalizeRemoteUrl(url: string): string | null {
  let s = url.trim();
  if (!s) return null;

  // Strip .git suffix
  s = s.replace(/\.git$/i, "");

  // SCP-like: git@host:owner/repo (no scheme, no slash before colon).
  // Both capture groups are non-empty by construction whenever scpMatch is
  // non-null: group 2 is `[^:\s/]+`, group 3 is `(.+)`, both `+` (>=1 char).
  // desktop/tsconfig.node.json's noUncheckedIndexedAccess can't see that
  // regex guarantee, so it types RegExpMatchArray indices as possibly
  // undefined -- guard explicitly (fall through to the next branch, never
  // silently drop the match) instead of `!`/`as` past the compiler.
  const scpMatch = s.match(/^([^@\s:/]+)@([^:\s/]+):(?!\/)(.+)$/);
  if (scpMatch && !s.includes("://")) {
    const rawHost = scpMatch[2];
    const rawPath = scpMatch[3];
    if (rawHost !== undefined && rawPath !== undefined) {
      return `${rawHost.toLowerCase()}/${rawPath.replace(/^\/+/, "")}`;
    }
  }

  // Protocol URLs: ssh://, git://, http://, https://. Same guarantee as
  // above: group 1 is `(.+)`, non-empty whenever protoMatch is non-null.
  const protoMatch = s.match(/^[a-z+]+:\/\/(.+)$/i);
  const protoRest = protoMatch?.[1];
  if (protoRest !== undefined) {
    let rest = protoRest;
    const atIdx = rest.indexOf("@");
    const slashIdx = rest.indexOf("/");
    if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
      rest = rest.slice(atIdx + 1);
    }
    const firstSlash = rest.indexOf("/");
    if (firstSlash === -1) {
      return rest.toLowerCase();
    }
    let host = rest.slice(0, firstSlash);
    const path = rest.slice(firstSlash + 1);
    const colonIdx = host.indexOf(":");
    if (colonIdx !== -1) host = host.slice(0, colonIdx);
    return `${host.toLowerCase()}/${path}`;
  }

  return s.toLowerCase();
}

/**
 * Resolve the project key a session uses to scope both peer registration
 * and roadmap cards. Always non-null: the normalized git remote when there
 * is one, else a stable local fallback derived from the git root (or cwd
 * when there is no git root either) so repos without a remote still get a
 * per-project, per-machine scope. Deterministic for the same inputs -- two
 * calls with the same (remoteProjectKey, gitRoot, cwd) always agree.
 */
export function resolveProjectKey(
  remoteProjectKey: string | null,
  gitRoot: string | null,
  cwd: string
): string {
  if (remoteProjectKey) return remoteProjectKey;
  const anchor = gitRoot ?? cwd;
  return `local:${createHash("sha256").update(anchor, "utf-8").digest("hex").slice(0, 16)}`;
}
