// Card 3b0fda5f: the filter/search UI hands the two roadmap layouts a BOARD
// that is a subset of the true dispatch queue (see roadmap-data.ts). Every
// reorder commit must still be computed against the WHOLE unfiltered list --
// QueueSource is a branded wrapper only queueSourceOf can mint, so a call
// site that wanted to build one from a filtered array has to write the
// visibly-wrong `queueSourceOf(board)` instead of quietly passing the wrong
// array. This suite proves BOTH halves: the right source produces the full
// count, and the wrong source (kept in the diff on purpose, per this
// project's "a probe left out of the commit is not a guard" convention)
// produces the smaller, wrong count -- without that second assertion this
// test is green whether the source used is right or wrong.

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RoadmapItem } from '../desktop/src/shared/types'
import {
  buildAppendToQueue,
  buildInsertIntoQueue,
  buildStackIntoQueue,
  queueSourceOf
} from '../desktop/src/shared/workflow'

function item(id: string, over: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id,
    project_key: 'k',
    kind: 'feature',
    title: id,
    description: '',
    rationale: '',
    context: '',
    priority: 'could',
    value: 'medium',
    effort: 'medium',
    status: 'planned',
    tags: [],
    depends_on: [],
    created_by: 'deck',
    updated_by: 'deck',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    deleted_at: null,
    queue: null,
    locked: false,
    locked_by: null,
    locked_at: null,
    directive: null,
    target_peer_ids: [],
    ...over
  }
}

// 10 queued cards, sequential queue positions (each its own wave); 3 of them
// ('a','b','c') are kind 'bug'. board = a client-side filter of `all` down
// to just those 3 -- exactly the shape roadmap-data.ts hands RoadmapBoard.
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
const all: RoadmapItem[] = IDS.map((id, i) =>
  item(id, { kind: i < 3 ? 'bug' : 'feature', queue: i + 1 })
)
const board = all.filter((i) => i.kind === 'bug') // exactly 3, by construction above

test('buildAppendToQueue from the true (unfiltered) source appends and keeps every existing id', () => {
  const payload = buildAppendToQueue(queueSourceOf(all), 'new-id')
  expect(new Set(payload.ids)).toEqual(new Set([...IDS, 'new-id']))
  expect(payload.ids.length).toBe(11)
  expect(payload.waves.flat()).toEqual(payload.ids)
})

test('COUNTER-PROBE: buildAppendToQueue from the FILTERED board silently drops the 7 hidden items', () => {
  // What the wrong source produces: only the 3 board ids + the new one, not
  // the 10 real queue entries. This is the bug the QueueSource type exists
  // to make impossible to write silently -- a caller building it from
  // `board` would have to write `queueSourceOf(board)`, greppable and
  // visibly wrong at the call site.
  const payload = buildAppendToQueue(queueSourceOf(board), 'new-id')
  expect(payload.ids.length).toBe(4)
  expect(new Set(payload.ids)).toEqual(new Set(['a', 'b', 'c', 'new-id']))
})

test('buildInsertIntoQueue from the true source inserts and keeps every existing id', () => {
  const payload = buildInsertIntoQueue(queueSourceOf(all), 'new-id', 0)
  expect(new Set(payload.ids)).toEqual(new Set([...IDS, 'new-id']))
  expect(payload.ids.length).toBe(11)
  expect(payload.waves.flat()).toEqual(payload.ids)
})

test('COUNTER-PROBE: buildInsertIntoQueue from the FILTERED board silently drops the 7 hidden items', () => {
  const payload = buildInsertIntoQueue(queueSourceOf(board), 'new-id', 0)
  expect(payload.ids.length).toBe(4)
  expect(new Set(payload.ids)).toEqual(new Set(['a', 'b', 'c', 'new-id']))
})

test('buildStackIntoQueue from the true source stacks and keeps every existing id', () => {
  const payload = buildStackIntoQueue(queueSourceOf(all), 'new-id', 'b', 'after')
  expect(new Set(payload.ids)).toEqual(new Set([...IDS, 'new-id']))
  expect(payload.ids.length).toBe(11)
  expect(payload.waves.flat()).toEqual(payload.ids)
})

test('COUNTER-PROBE: buildStackIntoQueue from the FILTERED board silently drops the 7 hidden items', () => {
  const payload = buildStackIntoQueue(queueSourceOf(board), 'new-id', 'b', 'after')
  expect(payload.ids.length).toBe(4)
  expect(new Set(payload.ids)).toEqual(new Set(['a', 'b', 'c', 'new-id']))
})

// Rooted on desktop/src rather than desktop/src/renderer alone, so a mint
// planted under shared/** or main/** is not invisible to the sweep; the
// definition file is exempted by name since its own prose mentions the patterns
// in English sentences describing the guarantee.
// Glob-driven rather than a hardcoded file list: queueSourceOf must be minted
// in exactly one place, and the `as QueueSource` escape hatch must never appear
// outside the definition file.
const DEFINITION_FILE = join('desktop', 'src', 'shared', 'workflow.ts')

function collectFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

test('queueSourceOf is minted in exactly one place across desktop/src', () => {
  const srcDir = join(import.meta.dir, '..', 'desktop', 'src')
  const files = collectFiles(srcDir, []).filter((f) => !f.endsWith(DEFINITION_FILE))
  let occurrences = 0
  const hits: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    const matches = text.match(/queueSourceOf\(/g)
    if (matches) {
      occurrences += matches.length
      hits.push(`${file}: ${matches.length}`)
    }
  }
  expect(occurrences, `expected exactly one queueSourceOf( call, found: ${hits.join(', ')}`).toBe(1)
})

test('`as QueueSource` never appears outside the definition file', () => {
  const srcDir = join(import.meta.dir, '..', 'desktop', 'src')
  const files = collectFiles(srcDir, []).filter((f) => !f.endsWith(DEFINITION_FILE))
  const hits: string[] = []
  for (const file of files) {
    if (/as QueueSource\b/.test(readFileSync(file, 'utf-8'))) hits.push(file)
  }
  expect(hits, `expected no 'as QueueSource' outside the definition file, found: ${hits.join(', ')}`).toEqual(
    []
  )
})
