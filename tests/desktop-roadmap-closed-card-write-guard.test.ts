// Card 99d3a9eb: a discipline test, in the shape of
// tests/desktop-workflow-queue-source.test.ts (enumerate every real call
// site by GLOB across the renderer subtree, fail closed the moment the
// enumeration finds one the table does not already know about) -- not a
// React-mount harness. Team-lead's own review measured that a mount would
// have caught NONE of tonight's four defects (an i18n orphan a mount never
// touches, a three-hop chain through two components, and two statically-
// readable unconditioned handlers) -- this lot is a COVERAGE problem
// (does a write site exist unaccounted for), not a sensitivity one (does
// the masked entry stay masked), and coverage is what an enumeration proves.
//
// WHAT THIS PROVES: every current call site of `window.api.roadmapUpsert(`
// or the per-file `upsert(` pass-through wrapper, in desktop/src/renderer,
// is accounted for by an exact PER-FILE COUNT plus a documented reason list.
// A NEW call site anywhere -- in a known file or a brand new one -- changes
// that file's live count and fails the test, forcing a human to look at it
// and extend the table, exactly the property that let team-lead's own menu
// addition (442084b7, this same evening) slip the desktop-i18n test's
// orphan check silently until re-measured by hand.
//
// KEYED BY FILE + COUNT, NOT FILE + LINE (review round 2 retouche): a
// file:line key rougit on every cosmetic edit that merely shifts lines below
// an unrelated change -- exactly the repo's own standing lesson that a link
// to code must hold by PATH + SYMBOL, never file:line, because the line
// moves and the symbol does not. A per-file line-number table degrades the
// same way: someone updates the numbers mechanically to get back to green
// without doing the review the table exists to force, and it stays green
// while meaning nothing. Per-file COUNT is immune to a pure reshuffle
// (nothing added or removed) while staying exactly as sensitive to a NEW
// site (the count moves) -- see the two red-first probes below, one for
// each half of that claim.
//
// WHAT THIS SCAN CANNOT SEE (asked for explicitly, review round 2):
// 1. A NEW local wrapper under a DIFFERENT name (not literally `upsert`)
//    that itself calls `window.api.roadmapUpsert` -- the wrapper's own
//    definition line still matches `roadmapUpsert(` and moves its file's
//    count (good), but every CALL SITE reaching the write through that
//    differently-named wrapper is invisible to this pattern; a human
//    reviewing the one new unclassified line would need to notice the
//    fan-out themselves, this test does not enumerate it for them.
// 2. A truly DYNAMIC dispatch (`window.api[someVar](...)` where `someVar`
//    holds the string at runtime, never appearing as the literal identifier
//    `roadmapUpsert` in source text) -- invisible to any source-text scan,
//    would need real interpretation.
// 3. Any OTHER write API by design -- `roadmapArchive`/`roadmapAssign`/
//    `roadmapStop`/`roadmapReorder`/`roadmapDispatch` are out of this
//    scan's scope on purpose (team-lead's own instruction named
//    "roadmapUpsert / le wrapper upsert" specifically); Archive/Restore are
//    the ONE surviving write action on a closed card by arbitrage 3, so
//    scanning them here would be the wrong question, not a missed one.
// 4. WHETHER a reason is actually TRUE. This test can only prove every site
//    is NAMED with a reason, not that the cited guard genuinely reaches it --
//    that remains a human review responsibility, same as any code review.
// 5. WHICH specific site a reason describes, once more than one site shares
//    a file -- the count+reasons-list form is an AGGREGATE correspondence
//    (N sites, N reasons, matched by a human during review), not a precise
//    per-site pin. Traded deliberately for immunity to line churn; a
//    reviewer who wants "which exact call is reason #3" re-derives it by
//    reading the file, same as before this test existed.
// 6. A SWAP inside an already-known file -- one site added and one removed
//    in the SAME file, same edit -- leaves that file's count unchanged and
//    stays GREEN. This is the direct price of point 5's own line-immunity
//    (review round 2's own retouche): counting occurrences instead of
//    pinning lines cannot distinguish "nothing changed" from "one thing
//    replaced another." Written down here as a KNOWN limit, not discovered
//    the day it bites.
// 7. Anything outside `desktop/src/renderer` -- the scan root is that
//    subtree only. A write reaching `window.api.roadmapUpsert` from
//    `desktop/src/main` (a different layer, a different API surface) would
//    never be scanned. Defensible (this card's four families are all
//    renderer UI), but unstated until now.
// 8. Comments and string literals are NOT stripped before matching. A bare
//    mention of `upsert(` or `roadmapUpsert(` in a comment or a template
//    string inflates a file's count and fails the test -- but only in the
//    NOISY direction (a real change is needed to go green again, nothing
//    slips through unseen), never in the direction that would hide a real
//    site. Worth knowing before chasing a false red as a code bug.
//
// Mirror-probe red-first proof (2026-08-31, mirror-probe recipe 1, reported
// to the team-lead, never committed), TWO probes for the two halves of the
// file+count claim:
// - NEW SITE must still bite: added a new unguarded call
//   (`upsert({id, priority})`) inside RoadmapList.tsx -- RED (that file's
//   live count read 8, table expected 7). Reverting restored GREEN.
// - PURE RESHUFFLE must stay silent: moved an existing call
//   (RoadmapList.tsx's `addDep`) down by 12 blank lines with no site added
//   or removed -- stayed GREEN (count unchanged), proving the retouche
//   actually closes the noisy-on-cosmetic-edit complaint the file:line form
//   had, not just in prose.

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

// NOT in KNOWN_SITES above, and NOT fixed as part of this card -- flagged to
// the team-lead instead. RoadmapList.tsx's `applyMove` has two callers this
// scan structurally cannot enumerate, because neither call contains the
// literal text `upsert(` -- they call `applyMove(` one level removed from
// the write itself: the Undo snackbar's onClick, and the "mark done"
// ConfirmDialog's onConfirm. Both read an item snapshot captured only AFTER
// moveTo()'s own `closed` guard already ran once, not re-checked at
// click/confirm time -- a concurrent session closing the same card between
// the snapshot and the click is invisible to a source-text scan (data-flow,
// not a missing textual gate), and is a narrower, different hazard class
// than B2's tap-through. This is exactly this file's header point 1's shape
// (a call reaching the write through an intermediate, differently-named
// function), demonstrated on real code instead of only asserted in prose.

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
