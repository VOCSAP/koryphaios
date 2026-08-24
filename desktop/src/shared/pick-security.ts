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

/**
 * Redact a string in place if it matches a secret pattern; otherwise pass
 * through unchanged. Single source of truth for both re-validation points
 * (guest-side element-pick.ts and main-side design-endpoint.ts) so a field
 * redacted on one side is redacted on the other -- moved here from
 * design-endpoint.ts, which had this as a private helper the guest twin
 * never saw.
 */
export function redactIfSecret(v: string): string {
  return containsSecret(v) ? '[redacted]' : v
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
 * True when `raw` parses as an absolute URL, regardless of protocol --
 * deliberately does NOT check ALLOWED_URL_PROTOCOLS. Lets a caller of
 * sanitizePickUrl tell apart its two failure modes, which callers must NOT
 * treat the same way: "not a URL at all" (parse failure -- safe to fall back
 * to the raw string, since something that never parsed cannot carry a query)
 * from "a URL that exists but is disallowed" (data:, javascript:, … --
 * exactly the class of input that CAN carry an embedded query/token, so a
 * caller falling back to the raw string here would leak the very thing
 * sanitizePickUrl exists to strip). See pick-prompt.ts's formatAnnotationsReport.
 */
export function isParseableUrl(raw: string): boolean {
  if (raw === 'about:blank') return true
  try {
    new URL(raw)
    return true
  } catch {
    return false
  }
}

/** True for any `aria-*` attribute name. */
export function isAriaAttributeName(name: string): boolean {
  return name.startsWith('aria-')
}

/**
 * Full domain of attribute names whose value is a URL and must go through
 * sanitizePickUrl rather than the generic cap-and-keep branch -- single
 * source of truth for both re-validation points (element-pick.ts guest side,
 * design-endpoint.ts main side), which used to each hardcode
 * `name === 'href' || name === 'src'` independently. Not every name here
 * ships in PICK_ATTRIBUTE_ALLOWLIST today (poster/action/formaction/srcset
 * are pre-classified for future growth) -- URL_ATTRS is the set of names
 * pick-security.ts knows how to sanitize as a URL; URL_ATTRS_ALLOWED below
 * decides which of them are actually captured.
 */
const URL_ATTR_NAMES = ['href', 'src', 'poster', 'action', 'formaction', 'srcset'] as const
export const URL_ATTRS: Set<string> = new Set(URL_ATTR_NAMES)
type UrlAttrName = (typeof URL_ATTR_NAMES)[number]

/**
 * Attribute names captured in the pick payload that are NOT URLs -- the
 * generic cap-and-keep branch. Safe, low-entropy names; every `aria-*` is
 * checked separately (isAriaAttributeName).
 */
const NON_URL_ATTRS = [
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

/**
 * URL-bearing attributes actually captured by the pick payload today --
 * typed as a subset of URL_ATTR_NAMES, so TypeScript rejects any entry here
 * that isn't already a member of URL_ATTRS. This is what makes the defect
 * measured in review structurally impossible to reintroduce: growing
 * PICK_ATTRIBUTE_ALLOWLIST with a new URL-bearing attribute can no longer be
 * done by editing PICK_ATTRIBUTE_ALLOWLIST itself (it is derived, not a
 * literal), and adding the attribute here without first adding it to
 * URL_ATTR_NAMES above is a compile error.
 */
const URL_ATTRS_ALLOWED: UrlAttrName[] = ['href', 'src']

/**
 * Attribute names captured in the pick payload by default -- PARTITIONED by
 * construction into NON_URL_ATTRS and URL_ATTRS_ALLOWED (plus every
 * `aria-*`, checked separately, see isAriaAttribute-style callers in
 * element-pick.ts). Shared so main-side re-validation filters against the
 * exact same set the guest used.
 */
export const PICK_ATTRIBUTE_ALLOWLIST: string[] = [...NON_URL_ATTRS, ...URL_ATTRS_ALLOWED]

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
  roleMaxLength: 64,
  /** Whole `reactComponents` string cap (formatted "<App> > <Card>", OD3). */
  reactComponentsMaxLength: 200,
  /** `sourceFile` cap: "path/to/Component.tsx:42:7" (OD3). */
  sourceFileMaxLength: 300,
  /** Unique component names collected walking the fiber tree (OD3). */
  reactComponentsMaxEntries: 6,
  /** Annotate review (OD5): comment textarea cap, mirrors orca's GRAB_BUDGET. */
  annotationCommentMaxLength: 2000,
  /** Annotate review (OD5): pinned-elements cap per review; further picks are refused with a toast. */
  annotationsMaxPerPage: 20
} as const
