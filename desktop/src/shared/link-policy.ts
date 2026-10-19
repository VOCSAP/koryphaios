// Policy of Ctrl/Cmd+click on a terminal link: which file types may be
// launched and which locations never are. Both lists live in the global app
// config (never a cloned repo) and are validated here, at every boundary that
// can write or read them.

/** Documents and images a viewer shows, never something that runs. */
export const DEFAULT_LINK_EXTENSIONS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.md', '.txt', '.log', '.json'
]

/**
 * A bare name excludes every path that has it as a segment; an absolute path or
 * a `~/` path excludes that file or directory and everything under it.
 */
export const DEFAULT_LINK_EXCLUSIONS: readonly string[] = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.credentials.json', 'operator.json', 'companion-cert.json'
]

/**
 * Types that execute, script, install or hand control to a registered handler:
 * Ctrl/Cmd+click only shows them in their folder, whatever the allow-list says.
 */
export const NEVER_OPENED_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    // Windows
    'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
    'msi', 'msp', 'msix', 'appx', 'appinstaller', 'lnk', 'url', 'scf', 'rdp', 'reg', 'inf', 'cpl', 'msc', 'jar',
    'chm', 'application', 'appref-ms', 'gadget', 'settingcontent-ms', 'library-ms', 'search-ms', 'theme',
    'themepack', 'iso', 'img', 'vhd', 'vhdx',
    // Office macros
    'docm', 'xlsm', 'pptm', 'xlam', 'ppam', 'xll',
    // Documents a viewer can script
    'html', 'htm', 'xhtml', 'mht', 'mhtml', 'svg', 'xml', 'pdf',
    // macOS
    'app', 'command', 'tool', 'terminal', 'workflow', 'action', 'scpt', 'scptd', 'pkg', 'dmg', 'webloc', 'inetloc', 'fileloc',
    // Linux
    'desktop', 'sh', 'bash', 'run', 'bin', 'appimage', 'jnlp',
    // Interpreters
    'py', 'pyw', 'rb', 'pl', 'php'
  ].map((name) => `.${name}`)
)

export const LINK_LIST_MAX_ENTRIES = 64
const MAX_ENTRY_CHARS = 260
const EXTENSION_RE = /^\.[a-z0-9]{1,16}$/
const SEPARATOR_RE = /[\\/]/
const ABSOLUTE_RE = /^(?:\/(?![\\/])|[A-Za-z]:[\\/])/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

function entries(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LINK_LIST_MAX_ENTRIES) return null
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') return null
    out.push(v.trim())
  }
  return out
}

type LinkListKey = 'linkOpenExtensions' | 'linkOpenExclusions'

const LINK_LISTS: Record<LinkListKey, { sanitize: (raw: unknown) => string[] | null; fallback: readonly string[] }> = {
  linkOpenExtensions: { sanitize: sanitizeLinkExtensions, fallback: DEFAULT_LINK_EXTENSIONS },
  linkOpenExclusions: { sanitize: sanitizeLinkExclusions, fallback: DEFAULT_LINK_EXCLUSIONS }
}

/** The two lists of a stored config: an absent one is the default, an unusable one is the default with a trace. */
export function linkListsFromStored(
  raw: Partial<Record<LinkListKey, unknown>>,
  report: (message: string) => void
): Record<LinkListKey, string[]> {
  const out = {} as Record<LinkListKey, string[]>
  for (const key of Object.keys(LINK_LISTS) as LinkListKey[]) {
    const clean = LINK_LISTS[key].sanitize(raw[key])
    if (clean === null && raw[key] !== undefined) report(`invalid ${key} in config.json, using the default list`)
    out[key] = clean ?? [...LINK_LISTS[key].fallback]
  }
  return out
}

/** The two lists of a config as the opener reads them: each in its own field, copied so a caller cannot edit the config through it. */
export function linkPolicyOf(cfg: Record<LinkListKey, readonly string[]>): { extensions: string[]; exclusions: string[] } {
  return { extensions: [...cfg.linkOpenExtensions], exclusions: [...cfg.linkOpenExclusions] }
}

/**
 * A config patch from the renderer with its lists normalised; an unusable list
 * is dropped from the patch, with a trace. A key present with an undefined value
 * is unusable too: spread over the stored config it would erase the list.
 */
export function sanitizeLinkPatch<T extends Partial<Record<LinkListKey, unknown>>>(patch: T, report: (message: string) => void): T {
  const out = { ...patch }
  for (const key of Object.keys(LINK_LISTS) as LinkListKey[]) {
    if (!(key in out)) continue
    const clean = LINK_LISTS[key].sanitize(out[key])
    if (clean === null) {
      report(`rejected config:set ${key} (not a usable list)`)
      delete out[key]
    } else {
      Object.assign(out, { [key]: clean })
    }
  }
  return out
}

/** Lower-case, dot-prefixed, deduplicated extensions, or null when the value is not a usable list or holds a never-opened type. */
export function sanitizeLinkExtensions(raw: unknown): string[] | null {
  const list = entries(raw)
  if (list === null) return null
  const out = new Set<string>()
  for (const v of list) {
    const ext = (v.startsWith('.') ? v : `.${v}`).toLowerCase()
    if (!EXTENSION_RE.test(ext) || NEVER_OPENED_EXTENSIONS.has(ext)) return null
    out.add(ext)
  }
  return [...out]
}

/**
 * Deduplicated exclusion entries (bare name, absolute path or `~/` path), or null
 * when the value is not a usable list. A comma is the separator of the Settings
 * field, so an entry holding one could not survive a round trip through it.
 */
export function sanitizeLinkExclusions(raw: unknown): string[] | null {
  const list = entries(raw)
  if (list === null) return null
  const out = new Set<string>()
  for (const v of list) {
    if (v.length === 0 || v.length > MAX_ENTRY_CHARS || CONTROL_RE.test(v) || v.includes(',')) return null
    const isHomePath = v.startsWith('~/') || v.startsWith('~\\')
    if (SEPARATOR_RE.test(v)) {
      if (!isHomePath && !ABSOLUTE_RE.test(v)) return null
    } else if (v === '.' || v === '..' || v === '~') {
      return null
    }
    out.add(v)
  }
  return [...out]
}
