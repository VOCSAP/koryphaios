// Peer ROLE (card a2f61172): what an agent DOES, as an operator-chosen
// attribute carried to the spawned session through CLAUDE_PEERS_ROLE. It is a
// separate question from the team-lead laurel (which announce target THIS
// window has); the two never derive from each other.

/**
 * Roles this project actually staffs, offered first in the create menu. The
 * list is app-defined on purpose: it must NOT come from the cloned repo, since
 * a repo-supplied value is hostile input #1 (CLAUDE.md) and a role placed by a
 * checked-in file would defeat the whole point of an operator gesture.
 */
export const BUILTIN_ROLES = [
  'team-lead',
  'developer',
  'reviewer',
  'explorer',
  'architect',
  'test-engineer',
  'doc-writer',
  'security-auditor',
  'debugger',
  'release-engineer',
  'web-designer'
] as const

/** Longest role the broker accepts (32 chars, first and last alphanumeric). */
export const ROLE_MAX = 32

/**
 * Coerce free text into the broker's role shape `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`.
 * The broker re-normalises and has the final say -- this is typing assistance
 * (and a clamp on what the Deck stores in the operator config), never the
 * guarantee. Returns '' when nothing usable remains.
 */
export function sanitizeRole(value: string): string {
  const kebab = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ROLE_MAX)
  // The slice can leave a trailing dash, which the pattern forbids.
  return kebab.replace(/-+$/, '')
}

/**
 * The dropdown's list: the built-ins, then the operator's own additions, in
 * the order they were added. Deduped case-insensitively so re-typing a
 * built-in through "Other…" cannot create a twin entry.
 */
export function mergeRoleChoices(custom: readonly string[]): string[] {
  const out: string[] = [...BUILTIN_ROLES]
  for (const raw of custom) {
    const role = sanitizeRole(raw)
    if (role && !out.includes(role)) out.push(role)
  }
  return out
}
