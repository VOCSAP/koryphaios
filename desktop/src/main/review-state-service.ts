// No electron import, so this stays bun-testable on a throwaway tmp file
// without booting the app.
// The output object is built field by field from the untrusted input, never by
// spreading it, so an unknown field is silently dropped rather than riding
// along into a shape nothing here checked.
// Any single item failing validation rejects the whole file: a review is one
// unit the operator composed together, and half of it silently surviving is
// worse than a visibly empty draft that gets redone.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { sanitizePick } from './design-endpoint'
import { realpathWithin } from './diff-service'
import { PICK_BUDGET, sanitizePickUrl } from '../shared/pick-security'
import type { PersistedReview, PickAnnotation, PickAnnotationIntent, PickAnnotationPriority, PickRegion } from '../shared/types'

export { REVIEW_STATE_VERSION, type PersistedReview } from '../shared/types'

const INTENTS: readonly PickAnnotationIntent[] = ['fix', 'change', 'question', 'approve']
const PRIORITIES: readonly PickAnnotationPriority[] = ['blocking', 'important', 'suggestion']
const REGION_TOOLS: readonly PickRegion['tool'][] = ['freehand', 'circle']

/** Coerce+validate an untrusted `region` shape; null on any violation. */
function validateRegion(raw: unknown): PickRegion | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = r.x
  const y = r.y
  const width = r.width
  const height = r.height
  if (typeof x !== 'number' || Number.isNaN(x)) return null
  if (typeof y !== 'number' || Number.isNaN(y)) return null
  if (typeof width !== 'number' || Number.isNaN(width)) return null
  if (typeof height !== 'number' || Number.isNaN(height)) return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null
  if (x < 0 || y < 0) return null
  if (!(width > 0 && width <= 20000)) return null
  if (!(height > 0 && height <= 20000)) return null
  if (typeof r.tool !== 'string' || !REGION_TOOLS.includes(r.tool as PickRegion['tool'])) return null
  if (typeof r.pageUrl !== 'string') return null
  return {
    x,
    y,
    width,
    height,
    tool: r.tool as PickRegion['tool'],
    pageUrl: sanitizePickUrl(r.pageUrl)
  }
}

/**
 * Validate one untrusted annotation item; null on any rule violation (the
 * caller then rejects the whole file). `seenIds` is shared across the whole
 * annotations array so a duplicate id is caught here, at item-validation
 * time, rather than needing a second pass over the output.
 */
function validateAnnotation(raw: unknown, seenIds: Set<string>): PickAnnotation | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>

  if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > 128) return null
  if (seenIds.has(a.id)) return null

  if (typeof a.comment !== 'string') return null
  const comment = a.comment.slice(0, PICK_BUDGET.annotationCommentMaxLength)

  if (typeof a.intent !== 'string' || !INTENTS.includes(a.intent as PickAnnotationIntent)) return null
  if (typeof a.priority !== 'string' || !PRIORITIES.includes(a.priority as PickAnnotationPriority)) return null

  const hasPick = a.pick !== undefined && a.pick !== null
  const hasRegion = a.region !== undefined && a.region !== null
  if (hasPick === hasRegion) return null // exactly one of pick / region

  let pick: PickAnnotation['pick']
  let region: PickAnnotation['region']
  if (hasPick) {
    const sanitized = sanitizePick(a.pick)
    if (!sanitized) return null
    pick = sanitized
  } else {
    const validated = validateRegion(a.region)
    if (!validated) return null
    region = validated
  }

  let screenshotPath: string | undefined
  if (a.screenshotPath !== undefined) {
    if (typeof a.screenshotPath !== 'string') return null
    screenshotPath = a.screenshotPath
  }

  seenIds.add(a.id)
  const out: PickAnnotation = {
    id: a.id,
    comment,
    intent: a.intent as PickAnnotationIntent,
    priority: a.priority as PickAnnotationPriority
  }
  if (pick) out.pick = pick
  if (region) out.region = region
  if (screenshotPath !== undefined) {
    // Resolved async below (containment + existence) -- kept as a plain
    // string here, dropped by the caller if it doesn't check out. The
    // annotations dir is pruned after 7 days (browser:save-annotation), so a
    // stale reference is DROPPED, not treated as a validation failure: it
    // does not reject the whole review, it just loses that one screenshot.
    out.screenshotPath = screenshotPath
  }
  return out
}

/**
 * Validates an untrusted persisted-review body.
 * Strict and fail-closed: any violation anywhere in the array rejects the whole
 * file (returns null).
 * screenshotPath is the one exception: a path outside opts.annotationsDir, or
 * one whose file is missing (pruned after 7 days), is silently dropped from the
 * item rather than failing it -- the rest of the annotation is still good and
 * worth keeping.
 */
export async function validatePersistedReview(
  raw: unknown,
  opts: { annotationsDir: string }
): Promise<PersistedReview | null> {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1) return null
  if (typeof r.pageUrl !== 'string') return null
  if (!Array.isArray(r.annotations)) return null
  if (r.annotations.length > PICK_BUDGET.annotationsMaxPerPage) return null

  const seenIds = new Set<string>()
  const annotations: PickAnnotation[] = []
  for (const item of r.annotations) {
    const validated = validateAnnotation(item, seenIds)
    if (!validated) return null // one bad item fails the whole file
    annotations.push(validated)
  }

  // screenshotPath containment/existence check happens after the sync
  // validation pass above (it's the only async rule), one item at a time so
  // a rejected path is dropped from just that item, never the whole file.
  for (const item of annotations) {
    if (item.screenshotPath === undefined) continue
    const ok =
      (await realpathWithin(opts.annotationsDir, relativeToDir(opts.annotationsDir, item.screenshotPath))) &&
      existsSync(item.screenshotPath)
    if (!ok) delete item.screenshotPath
  }

  return {
    version: 1,
    pageUrl: sanitizePickUrl(r.pageUrl),
    annotations
  }
}

/**
 * realpathWithin (diff-service.ts) takes a path RELATIVE to `dir`; a
 * persisted screenshotPath is stored absolute (browser:save-annotation
 * returns an absolute path). node:path.relative gives the containment check
 * something it can resolve the same way a repo-relative diff path would.
 */
function relativeToDir(dir: string, absolutePath: string): string {
  return relative(dir, absolutePath)
}

/**
 * Read + validate the persisted review at `file`. Missing file is the
 * NORMAL state (no review ever saved / cleared) and returns null silently,
 * no trace. Anything else that keeps this from returning a good review --
 * unreadable file, unparseable JSON, a body that fails validatePersistedReview
 * -- reports through `report` (the caller wires this to reportError) and
 * still returns null: never throws, so a corrupt/tampered state file can
 * never crash the renderer's load-on-mount.
 */
export async function readReviewState(
  file: string,
  opts: { annotationsDir: string; report: (msg: string, err: unknown) => void }
): Promise<PersistedReview | null> {
  if (!existsSync(file)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    opts.report('review state file is unreadable or not valid JSON', err)
    return null
  }
  try {
    const validated = await validatePersistedReview(raw, { annotationsDir: opts.annotationsDir })
    if (!validated) {
      opts.report('review state file failed validation', null)
      return null
    }
    return validated
  } catch (err) {
    opts.report('review state validation threw', err)
    return null
  }
}

/** Serialized-size cap (512 KiB) — well above any realistic review, far below IPC pain. */
export const REVIEW_STATE_MAX_BYTES = 512 * 1024

/** Write `state` atomically (temp file + rename), creating the parent dir if needed. */
export async function writeReviewState(file: string, state: PersistedReview): Promise<void> {
  const json = JSON.stringify(state, null, 2)
  if (Buffer.byteLength(json, 'utf8') > REVIEW_STATE_MAX_BYTES) {
    throw new Error(`review state exceeds ${REVIEW_STATE_MAX_BYTES} bytes`)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(file, json)
}

/** Delete the persisted review, if any; no error when the file is already absent. */
export async function clearReviewState(file: string): Promise<void> {
  try {
    rmSync(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') throw err
  }
}
