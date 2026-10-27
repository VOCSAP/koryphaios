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
  const region: PickRegion = {
    x,
    y,
    width,
    height,
    tool: r.tool as PickRegion['tool'],
    pageUrl: sanitizePickUrl(r.pageUrl)
  }
  for (const key of ['scrollX', 'scrollY'] as const) {
    const v = r[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
    region[key] = v
  }
  return region
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
 * `review-pending.json` = { projects: { [project_key]: PersistedReview } }.
 * PROJECT scope, keyed like approvals.json: a pending review belongs to the
 * repository, not to the window, and is worth finding again after a restart.
 * Two windows on distinct repos hold distinct entries in one file.
 */
interface ReviewStore {
  projects: Record<string, unknown>
}

type StoreRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'ok'; store: ReviewStore }

/**
 * Missing file is the NORMAL state. Anything else that is not the keyed
 * layout -- unparseable JSON, a body that is not an object, or the earlier
 * unkeyed layout (one review for the whole machine, unattributable to a
 * project) -- reports and reads as unreadable, so a write replaces it and a
 * read never surfaces another project's review.
 */
function readStore(file: string, report: (msg: string, err: unknown) => void): StoreRead {
  if (!existsSync(file)) return { kind: 'absent' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    report('review state file is unreadable or not valid JSON', err)
    return { kind: 'unreadable' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    report('review state file is not an object', null)
    return { kind: 'unreadable' }
  }
  const projects = (raw as { projects?: unknown }).projects
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    report('review state file predates project keying (one review for the whole machine), ignored', null)
    return { kind: 'unreadable' }
  }
  return { kind: 'ok', store: { projects: projects as Record<string, unknown> } }
}

/**
 * Read + validate the review persisted for `projectKey`. No file, or no entry
 * for this project, returns null silently. A body that fails
 * validatePersistedReview reports through `report` (the caller wires this to
 * reportError) and still returns null: never throws, so a corrupt/tampered
 * state file can never crash the renderer's load-on-mount.
 */
export async function readReviewState(
  file: string,
  projectKey: string,
  opts: { annotationsDir: string; report: (msg: string, err: unknown) => void }
): Promise<PersistedReview | null> {
  const read = readStore(file, opts.report)
  if (read.kind !== 'ok') return null
  const raw = read.store.projects[projectKey]
  if (raw === undefined) return null
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

/** Serialized-size cap (512 KiB) per review — well above any realistic review, far below IPC pain. */
export const REVIEW_STATE_MAX_BYTES = 512 * 1024

function writeStore(file: string, store: ReviewStore): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(file, JSON.stringify(store, null, 2))
}

/**
 * Write `state` under `projectKey` atomically (temp file + rename), keeping
 * the other projects' entries. An unreadable file (corrupt, or the unkeyed
 * layout) is reported through `report` and replaced. Read-modify-write
 * without a lock: two windows writing the same instant lose one entry, a
 * loss never a leak.
 */
export async function writeReviewState(
  file: string,
  projectKey: string,
  state: PersistedReview,
  report: (msg: string, err: unknown) => void
): Promise<void> {
  const json = JSON.stringify(state)
  if (Buffer.byteLength(json, 'utf8') > REVIEW_STATE_MAX_BYTES) {
    throw new Error(`review state exceeds ${REVIEW_STATE_MAX_BYTES} bytes`)
  }
  const read = readStore(file, report)
  const store: ReviewStore = read.kind === 'ok' ? read.store : { projects: {} }
  store.projects[projectKey] = state
  writeStore(file, store)
}

/**
 * Delete the review persisted for `projectKey`; the file goes with its last
 * entry. No error when the file or the entry is already absent. An
 * unreadable file is reported and removed: nothing in it can be read back.
 */
export async function clearReviewState(
  file: string,
  projectKey: string,
  report: (msg: string, err: unknown) => void
): Promise<void> {
  const read = readStore(file, report)
  if (read.kind === 'absent') return
  if (read.kind === 'unreadable') {
    rmSync(file, { force: true })
    return
  }
  if (!(projectKey in read.store.projects)) return
  delete read.store.projects[projectKey]
  if (Object.keys(read.store.projects).length === 0) {
    rmSync(file, { force: true })
    return
  }
  writeStore(file, read.store)
}
