// Per-rule "Active" toggles of the guard rules, stored as ONE config list of
// disabled keys (`AppConfig.ttsrDisabled`): a rule added later, in any source,
// is active by default. Keys carry their source, and a repo rule also carries
// its project key, so two projects shipping the same rule id never share a
// toggle:
//
//   kory/<id>    user/<id>    repo/<project_key>/<id>
//
// A project key may itself contain "/" (a normalized remote such as
// github.com/owner/repo), so a repo key is split on its LAST "/": rule ids are
// kebab-case and never hold one.
//
// Pure module: node builtins only, no electron, so the sanitizer runs under
// bun test and in store.ts / setConfig alike.

import { validateProjectKey } from '../../../shared/project-key'
import { MAX_ID_CHARS, type TtsrSource } from '../shared/ttsr-rules'

/** Upper bound of the disabled list; entries past it are dropped. */
export const TTSR_DISABLED_MAX = 1000

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isRuleId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_CHARS && ID_RE.test(id)
}

/** The toggle key of one rule. `projectKey` is required for (and only read on) a repo rule. */
export function ttsrToggleKey(source: TtsrSource, id: string, projectKey?: string): string {
  if (source === 'repo') {
    if (!projectKey) throw new Error(`ttsr: a repo rule toggle needs a project key (rule "${id}")`)
    return `repo/${projectKey}/${id}`
  }
  return `${source}/${id}`
}

/** True for a string of one of the three key shapes, with a valid id and project key. */
export function isTtsrToggleKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.startsWith('kory/') || value.startsWith('user/')) return isRuleId(value.slice(5))
  if (!value.startsWith('repo/')) return false
  const rest = value.slice(5)
  const cut = rest.lastIndexOf('/')
  if (cut <= 0) return false
  return validateProjectKey(rest.slice(0, cut)).ok && isRuleId(rest.slice(cut + 1))
}

/**
 * The disabled list as it may be persisted: an array of well-formed keys,
 * deduplicated, capped. Anything else (a hand-edited file, a renderer patch)
 * is dropped entry by entry; a dropped entry only ever re-enables a rule.
 */
export function sanitizeTtsrDisabled(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (out.length >= TTSR_DISABLED_MAX) break
    if (!isTtsrToggleKey(v) || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}
