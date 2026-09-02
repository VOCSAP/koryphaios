// Enumerates every window.api.roadmapUpsert (or the per-file upsert wrapper)
// call site under desktop/src/renderer, keyed by per-file count rather than
// file:line so a pure line reshuffle can't false-red.
// Blind spots: a differently-named wrapper's own call sites, truly dynamic
// dispatch, other write APIs by design, whether a cited reason is actually
// true, and a same-file swap (one site added, one removed) that leaves the
// count unchanged.
// Comments and string literals are not stripped before matching, so a bare
// mention of upsert( inflates a count -- only in the noisy direction, never
// hiding a real site.

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface FileEntry {
  file: string
  /** Expected number of `roadmapUpsert(`/`\bupsert\(` matches in this file. */
  count: number
  /**
   * One entry per site, in no particular order relative to the file's own
   * line order (see header point 5) -- length MUST equal `count`, checked
   * below, so the two numbers can never silently drift apart.
   */
  reasons: string[]
}

// Card 99d3a9eb review round 2: every site measured tonight turned out to be
// guarded at its CALLER (an entry point already masked/gated elsewhere), not
// inside its own body -- so no reason below claims a call site guards
// itself; the mechanical check does not care which shape a reason
// describes, only that the count and the reason-list length agree.
const KNOWN_SITES: FileEntry[] = [
  {
    file: join('renderer', 'src', 'components', 'RoadmapView.tsx'),
    count: 10,
    reasons: [
      "save(): only reachable via setDraft(), itself only reachable from menuItems()'s Edit entry (absent from the closed branch) or RoadmapItemModal's pencil (masked on closed).",
      'restore(): the surviving cycle-of-life action itself on an archived card (arbitrage 3).',
      "setQueue(): menuItems()'s queue-remove entry is absent from the closed branch; the WorkflowLane path is explicitly out of this card's measured scope (WorkflowLane.tsx has only a canvas context menu, no per-card menu).",
      "addDep(): only reachable via RoadmapItemModal's dep-editor +, masked on closed (AC1).",
      "removeDep(): only reachable via RoadmapItemModal's dep-chip x, masked on closed (AC1).",
      "stackItem(): dragId can only be a card RoadmapBoard.tsx's BoardCard marks draggable, which excludes closed cards by construction (arbitrage 2).",
      "applyMove() (desktop): reached only via moveItem()<-dropOn()<-dragId, same non-draggable-when-closed gate as stackItem() above.",
      "setPriority(): only reachable via the board's priority chip, which now no-ops (does not even open the picker) when locked or closed (AC2).",
      'toggleInactive(): the menu entry that calls it is absent from the closed branch entirely.',
      "CreateMenu onCreate (launch flow): launchItem is only set via RoadmapItemModal's onLaunch (masked on closed) or the Assign flow's 'new agent' button, itself only reachable via menuItems()'s Assign entry (absent from the closed branch)."
    ]
  },
  {
    file: join('renderer', 'src', 'components', 'RoadmapList.tsx'),
    count: 8,
    reasons: [
      "upsert()'s own definition body (`await window.api.roadmapUpsert(patch)`) -- generic pass-through plumbing, not an action; its call sites below are the real sites.",
      "addDep(): same RoadmapItemModal dep-editor gate as desktop's addDep() -- shared modal, AC1.",
      "removeDep(): same RoadmapItemModal dep-chip gate as desktop's removeDep() -- shared modal, AC1.",
      'applyMove(): reached only via moveTo(), which now checks closed directly (B2) -- the ONE site whose caller-side guard is one hop up, not two or three.',
      'action-sheet Restaurer: the surviving cycle-of-life action itself, only rendered in the archived branch.',
      "edit sheet save: reachable via the action sheet's Edit button (masked on closed) or RoadmapItemModal's onEdit (masked on closed).",
      "onUnqueue: wired to RoadmapItemModal's queue add/remove block, already correctly excluded on done/archived before this card (pre-existing, verified correct).",
      'onRestore: the surviving cycle-of-life action itself, mirrors RoadmapView.tsx.'
    ]
  },
  {
    file: join('renderer', 'src', 'components', 'BrowserView.tsx'),
    count: 1,
    reasons: [
      "createReviewCards(): CREATION only -- annotationToCardFields (shared/pick-card.ts) is a pick-list build that never sets `id`, so this site cannot address an existing card, closed or not; reached only through the review panel's Create-cards ConfirmDialog (tests/desktop-pick-card.test.ts pins the exact field set)."
    ]
  }
]

// RoadmapList.tsx's applyMove has two callers this scan can't see, since
// neither call contains the literal text upsert(: the Undo snackbar's onClick
// and the mark-done confirm dialog's onConfirm.
// Both read an item snapshot captured before moveTo's own closed guard runs, so
// a concurrent close between the snapshot and the click is invisible to a
// source-text scan.

const SCAN_ROOT = join(import.meta.dir, '..', 'desktop', 'src')

function collectFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * `roadmapUpsert(` catches every call through `window.api.roadmapUpsert`
 * AND a local wrapper's own internal call (its definition line). `\bupsert\(`
 * catches every CALL to a locally-named `upsert` wrapper, word-bounded so it
 * never matches the tail of `roadmapUpsert(` (no boundary between two word
 * characters) -- see this file's header comment, point 1, for the wrapper
 * escape hatch this pattern cannot close.
 */
function scanWriteSiteCounts(): Map<string, number> {
  const files = collectFiles(join(SCAN_ROOT, 'renderer'), [])
  const counts = new Map<string, number>()
  for (const file of files) {
    const rel = file.slice(SCAN_ROOT.length + 1)
    const text = readFileSync(file, 'utf-8')
    // `roadmapUpsert(` and `\bupsert\(` never both match the SAME
    // occurrence -- `\b` requires a boundary immediately before `upsert`,
    // and the character before it in `roadmapUpsert(` is `p` (a word
    // character), so there is no boundary there. A plain sum is therefore
    // an exact per-occurrence count, never a double-count.
    const roadmapUpsertMatches = (text.match(/roadmapUpsert\(/g) ?? []).length
    const wrapperMatches = (text.match(/\bupsert\(/g) ?? []).length
    const n = roadmapUpsertMatches + wrapperMatches
    if (n > 0) counts.set(rel, n)
  }
  return counts
}

test('every file with a roadmapUpsert/upsert call site has the expected count, no unknown file appears', () => {
  const found = scanWriteSiteCounts()
  const knownByFile = new Map(KNOWN_SITES.map((e) => [e.file, e.count]))

  const foundFiles = [...found.keys()].sort()
  const knownFiles = [...knownByFile.keys()].sort()
  expect(
    foundFiles,
    `files with write call sites: found ${JSON.stringify(foundFiles)}, table knows ${JSON.stringify(knownFiles)} -- a NEW file appearing means a new component now writes roadmapUpsert and needs an entry`
  ).toEqual(knownFiles)

  for (const [file, expectedCount] of knownByFile) {
    expect(found.get(file), `${file}: expected ${expectedCount} write call site(s)`).toBe(expectedCount)
  }
})

test('every file entry carries exactly as many reasons as its count', () => {
  const mismatched = KNOWN_SITES.filter((e) => e.reasons.length !== e.count)
  expect(
    mismatched.map((e) => `${e.file}: count=${e.count} reasons=${e.reasons.length}`),
    'count and reasons.length must agree, or the table is lying about how many sites it actually documents'
  ).toEqual([])
  const empty = KNOWN_SITES.flatMap((e) => e.reasons.filter((r) => r.trim().length === 0))
  expect(empty, 'no reason may be empty').toEqual([])
})

// Sensitivity control (mirrors this file's own "coverage vs sensitivity"
// point): a table that is merely non-empty proves nothing about the SCAN
// finding real sites -- prove the scan itself fires on a known-live pattern.
test('COUNTER-PROBE: the scan pattern does fire on real occurrences (sensitivity, not just table non-emptiness)', () => {
  const found = scanWriteSiteCounts()
  const total = [...found.values()].reduce((a, b) => a + b, 0)
  expect(total).toBeGreaterThan(10)
  expect(found.get(join('renderer', 'src', 'components', 'RoadmapView.tsx'))).toBeGreaterThan(0)
})
