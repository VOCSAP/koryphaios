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
 * Card 69e5a3e0: the whole key is lowercased, host AND owner/repo path.
 * GitHub (and most hosts) accept cloning a repo under several casings of its
 * path, so two clones of the same logical repo used to compute two distinct
 * keys, silently splitting a shared roadmap/graph/approval scope in two. The
 * one-shot cold migration for rows written under the pre-fix casing lives in
 * scripts/migrate-project-key-case.ts.
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
      return `${rawHost.toLowerCase()}/${rawPath.replace(/^\/+/, "").toLowerCase()}`;
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
    return `${host.toLowerCase()}/${path.toLowerCase()}`;
  }

  return s.toLowerCase();
}

const PROJECT_KEY_MAX_LENGTH = 256;
// C0 (U+0000-001F, covers NUL/\n/\r/\t), DEL (U+007F), C1 (U+0080-009F).
const PROJECT_KEY_CONTROL_CHAR_RE = /[\u0000-\u001F\u007F\u0080-\u009F]/;

export type ProjectKeyValidation =
  | { ok: true }
  | { ok: false; reason: "empty" | "too_long" | "surrounding_whitespace" | "control_char" };

/**
 * Card c92614ed lot L0: deny-list validation of a project_key VALUE already
 * extracted from a request body -- control/framing characters and a length
 * cap, never a charset allow-list. An ASCII allow-list was the first draft
 * and is measurably wrong against this file's own contract: normalizeRemoteUrl
 * legitimately produces non-ASCII (tests/project-key-normalize.test.ts's
 * "non-ASCII owner/repo path lowercases via Unicode-aware JS toLowerCase(),
 * never SQLite's ASCII-only LOWER()" pins "github.com/vocsap/été" as the
 * correct output of an accented remote,
 * since SQLite's LOWER() is ASCII-only and a downstream ASCII-fold would
 * fork a third, colliding key), and its no-scheme/no-scp fallback branch
 * (plain `s.toLowerCase()` above) legitimately produces backslashes, colons
 * and internal spaces for local-path remotes (/srv/git/foo.git,
 * C:\repos\foo, ../sibling). An allow-list derived from a sample already in
 * the peers table can only under-represent this producer's real codomain,
 * so it fails CLOSED on the next legitimate remote shape not yet seen --
 * the deny-list below is derived from the producer's contract, never from
 * what happens to be stored today.
 *
 * Rejects: C0 controls, DEL, C1 controls, leading/trailing whitespace, the
 * empty string, and anything over 256 chars -- a REFUSAL, not a silent
 * slice(): a truncated value quietly mints a second, colliding key for the
 * same project instead of surfacing the oversized input to its caller.
 *
 * Deliberately does NOT reject: non-ASCII, backslash, internal whitespace,
 * or colons (the `local:` prefix depends on the colon surviving). Homoglyphs
 * (a Cyrillic 'o' indistinguishable from a legitimate IDN path) are NOT
 * closed by this or any deny-list -- the absence of a rejection for them is
 * not a claim that they are handled, and no other mechanism in this repo
 * closes that vector for project_key today either (resolveRoadmapAuthor's
 * `[a-z0-9:_-]` allow-list closes the homoglyph class for the AUTHOR field
 * only, a different value with a different, much narrower legitimate
 * codomain -- it is not evidence of coverage here).
 *
 * Presence is the caller's concern, not this function's: a project_key-less
 * peer (e.g. a legacy row predating this field) is a valid state, so a
 * caller must check for null/absent BEFORE calling this, then only call it
 * once an actual string is in hand.
 *
 * WIRING CRITERION for every call site that takes a project_key from a
 * request body (card c92614ed lot L0, MAJOR 3 + MAJOR 4, team-lead review):
 * any handler that uses the value to WRITE -- storing it, or selecting the
 * rows of an UPDATE -- must call this and refuse on rejection. Only a pure
 * READ filter (`WHERE project_key = ?` with no downstream write) may skip
 * it, and only because a malformed value there can do nothing but fail to
 * match. This criterion lives here, not as an enumerated list at a call
 * site, because a list is already stale the day it ships (measured: a
 * decommented sweep at review time found an eighth `project_key`-reading
 * site this file's own test comments had not named) and a list in a TEST
 * file is invisible to whoever adds the next handler while working in
 * broker.ts.
 */
export function validateProjectKey(value: string): ProjectKeyValidation {
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > PROJECT_KEY_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (value.trim() !== value) return { ok: false, reason: "surrounding_whitespace" };
  if (PROJECT_KEY_CONTROL_CHAR_RE.test(value)) return { ok: false, reason: "control_char" };
  return { ok: true };
}

/**
 * Resolve the project key a session uses to scope both peer registration
 * and roadmap cards. Always non-null: the normalized git remote when there
 * is one, else a stable local fallback derived from the git root (or cwd
 * when there is no git root either) so repos without a remote still get a
 * per-project, per-machine scope. Deterministic for the same inputs -- two
 * calls with the same (remoteProjectKey, gitRoot, cwd) always agree.
 *
 * Card c92614ed lot L0 (MAJOR 1, team-lead review): a remote-derived key has
 * no length cap of its own -- normalizeRemoteUrl performs no truncation, so a
 * deeply nested GitLab path or a long `file://` remote can legitimately
 * normalize past PROJECT_KEY_MAX_LENGTH. Without this guard that value would
 * reach /register, collapse to NULL there (broker.ts's
 * normalizeIncomingProjectKey), and reopen the exact owner-gone regression
 * card 69e5a3e0/6aa32af4 exists to prevent: a NULL peers.project_key never
 * matches roadmap_items.project_key (a NOT NULL column, compared via
 * releaseStaleLocks' `IS`), so a perfectly legitimate, actively-heartbeating
 * session would have every one of its own locks swept as owner-gone.
 * Falling back to the deterministic local:<hash> below keeps the key valid
 * and the peer's own locks correctly attributed.
 */
export function resolveProjectKey(
  remoteProjectKey: string | null,
  gitRoot: string | null,
  cwd: string
): string {
  if (remoteProjectKey && remoteProjectKey.length <= PROJECT_KEY_MAX_LENGTH) return remoteProjectKey;
  const anchor = gitRoot ?? cwd;
  return `local:${createHash("sha256").update(anchor, "utf-8").digest("hex").slice(0, 16)}`;
}
