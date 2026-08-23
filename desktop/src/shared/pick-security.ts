// Element-pick security core (Chantier OD2, DESIGN-ORCA-DOOP-ADOPTION.md
// §3.4): the page a pick is taken from is an ADVERSARY. This module is the
// single source of truth for the budgets, the attribute allowlist and the
// redaction/sanitization primitives shared by both re-validation points:
//   - shared/element-pick.ts   (guest side: buildPick, in-page)
//   - main/design-endpoint.ts  (main side: sanitizePick, re-validates an
//     untrusted POST body from an external app -- defense in depth so a
//     compromised or malicious guest cannot smuggle anything past a single
//     check).
// Pure, zero imports, zero DOM -- must stay importable from guest, renderer
// AND main.

/**
 * Lowercase substrings that flag a value as secret-bearing (OAuth callback
 * params, credential-like strings). Deliberately narrow rather than broad
 * words like "code" or "state", which would false-positive on ordinary CSS
 * class names and IDs.
 */
export const PICK_SECRET_PATTERNS = [
  'access_token',
  'auth_token',
  'api_key',
  'apikey',
  'client_secret',
  'oauth_state',
  'x-amz-',
  'session_id',
  'sessionid',
  'csrf',
  'secret',
  'password',
  'passwd'
]

/** Case-insensitive substring match against PICK_SECRET_PATTERNS. */
export function containsSecret(v: string): boolean {
  const lower = v.toLowerCase()
  return PICK_SECRET_PATTERNS.some((p) => lower.includes(p))
}

/** Protocols allowed through a pick URL; everything else (javascript:, data:, …) is dropped. */
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

/**
 * Sanitize a URL for inclusion in a prompt: parse it, allow only
 * http(s)/file (plus the literal `about:blank`), strip query and fragment
 * everywhere (page URL, href/src attributes) so a pick on an OAuth callback
 * page can never carry a token into an agent prompt. Returns '' on parse
 * failure or a disallowed protocol -- this is what kills javascript: URIs.
 */
export function sanitizePickUrl(raw: string): string {
  if (raw === 'about:blank') return raw
  try {
    const u = new URL(raw)
    if (!ALLOWED_URL_PROTOCOLS.has(u.protocol)) return ''
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return ''
  }
}

/**
 * Attribute names captured in the pick payload by default. Safe, low-entropy
 * names plus every `aria-*` (checked separately, see isAriaAttribute-style
 * callers in element-pick.ts). Shared so main-side re-validation filters
 * against the exact same set the guest used.
 */
export const PICK_ATTRIBUTE_ALLOWLIST = [
  'href',
  'src',
  'alt',
  'title',
  'placeholder',
  'type',
  'name',
  'role',
  'disabled',
  'checked',
  'selected'
]

/** True for any `aria-*` attribute name. */
export function isAriaAttributeName(name: string): boolean {
  return name.startsWith('aria-')
}

/**
 * Every size/count cap used by the pick payload. Single source of truth:
 * element-pick.ts (guest) and design-endpoint.ts (main) both import from
 * here instead of hardcoding a duplicate that can drift.
 */
export const PICK_BUDGET = {
  textMaxLength: 160,
  selectorValueMaxLength: 512,
  classesMaxEntries: 8,
  selectorsMaxEntries: 8,
  idMaxLength: 128,
  pageUrlMaxLength: 1024,
  attributeValueMaxLength: 200,
  attributesMaxEntries: 24,
  styleValueMaxLength: 200,
  /** Style KEYS too: an external client controls them, so an unbounded key is a prompt-injection lane. */
  styleNameMaxLength: 48,
  stylesMaxEntries: 24,
  accessibleNameMaxLength: 120,
  ancestorLabelMaxLength: 40,
  /** Whole-entry cap for a main-side re-validated ancestor label (tag + class/aria-label wrapper). */
  ancestorEntryMaxLength: 80,
  ancestorsMaxEntries: 6,
  nearbyTextEntryMaxLength: 120,
  nearbyTextMaxEntries: 4,
  htmlMaxLength: 2048,
  roleMaxLength: 64
} as const
