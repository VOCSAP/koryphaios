// Single derivation for project_key, shared by peer registration and roadmap
// card scoping, so the two can never diverge.
// Pure module, no I/O -- server.ts has zero exports and runs main()
// unconditionally, so it cannot be imported directly for a unit test.

import { createHash } from "node:crypto";

/**
 * Normalizes a git remote URL into a stable cross-PC key: the entire key (host
 * and owner/repo path) is lowercased, since hosts accept several casings of the
 * same repo path.
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
 * Deny-list only, never a charset allow-list: normalizeRemoteUrl legitimately
 * produces non-ASCII and backslashes/colons/spaces for local-path remotes,
 * which an allow-list would reject.
 * Rejects control chars, DEL, leading/trailing whitespace, empty, and over 256
 * chars, by refusing rather than truncating.
 * Any write path (an INSERT or the row-selecting side of an UPDATE) using
 * project_key must call this and refuse on rejection; a pure read filter may
 * skip it since a malformed value merely fails to match.
 */
export function validateProjectKey(value: string): ProjectKeyValidation {
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > PROJECT_KEY_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (value.trim() !== value) return { ok: false, reason: "surrounding_whitespace" };
  if (PROJECT_KEY_CONTROL_CHAR_RE.test(value)) return { ok: false, reason: "control_char" };
  return { ok: true };
}

/**
 * Always returns non-null: the normalized git remote when present, else a
 * deterministic local:<hash> fallback so repos without a remote still get a
 * per-project scope.
 * Caps the remote-derived key length here since normalizeRemoteUrl performs no
 * truncation of its own -- an oversized value falls back locally rather than
 * passing through unchecked.
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
