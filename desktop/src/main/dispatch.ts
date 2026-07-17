// Queue → team-lead dispatch (PLAN C15): pure helpers for the operator's
// ordered "send to the lead next" queue on roadmap items. The wiring (broker
// reads, targeted announce, auto-dispatch watcher) lives in index.ts.
//
// SECURITY (C8 rule): the dispatch message is a CODE CONSTANT — never an
// operator/repo template.
//
// No electron imports so it is unit-testable under `bun test`.

import type { RoadmapItem } from '../shared/types'

/** Queued items ordered by position (ties broken by id for stability). */
export function queuedItems(items: RoadmapItem[]): RoadmapItem[] {
  return items
    .filter((i) => i.queue !== null && i.status !== 'done' && i.status !== 'archived')
    .sort((a, b) => (a.queue! - b.queue!) || a.id.localeCompare(b.id))
}

/** The next item to dispatch (lowest queue position), or null. */
export function firstQueued(items: RoadmapItem[]): RoadmapItem | null {
  return queuedItems(items)[0] ?? null
}

/** The position a newly queued item should take (max + 1). */
export function nextQueuePosition(items: RoadmapItem[]): number {
  return items.reduce((max, i) => (i.queue !== null && i.queue > max ? i.queue : max), 0) + 1
}

/**
 * The targeted announce sent to the team-lead when an item is dispatched:
 * the full item plus the workflow contract (assign, keep the status current).
 */
export function composeDispatchText(item: RoadmapItem): string {
  const lines = [
    `Next roadmap item from the operator's dispatch queue (id ${item.id.slice(0, 8)}):`,
    '',
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort} | Status: ${item.status}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    item.tags.length ? `Tags: ${item.tags.join(', ')}` : '',
    item.depends_on.length ? `Depends on: ${item.depends_on.map((d) => d.slice(0, 8)).join(', ')}` : '',
    '',
    'As team-lead: take it yourself or brief another peer with send_message. Use roadmap_get for full context, set the item in_progress with roadmap_update when the work REALLY starts (this locks it under the working peer), done when complete. Keep its status current — the Deck auto-dispatches the next queued item when this one is done.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

/**
 * Direct assignment of an item to ONE chosen peer (PLAN K6, the operator's
 * "process now" flow): the full item plus the take-it-now contract. Targeted
 * announce, so unlike the dispatch text there is no team-lead relaying step.
 * CODE CONSTANT (C8 rule).
 */
export function composeAssignText(item: RoadmapItem): string {
  const lines = [
    `The operator assigned THIS roadmap item to you — take it now (id ${item.id.slice(0, 8)}):`,
    '',
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort} | Status: ${item.status}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    item.tags.length ? `Tags: ${item.tags.join(', ')}` : '',
    item.depends_on.length ? `Depends on: ${item.depends_on.map((d) => d.slice(0, 8)).join(', ')}` : '',
    '',
    'Pause your current step if needed. Use roadmap_get for full context, set the item to in_progress with roadmap_update when you actually start (this locks it under your peer_id), done when complete — or back to planned if you must abandon it.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

/**
 * The operator's STOP notice on an in_progress item (PLAN K3). Sent to the
 * supervisor (coordinate + report back) or broadcast to the whole group as a
 * fallback. Like the dispatch text, this is a CODE CONSTANT (C8 rule).
 */
export function composeStopText(item: RoadmapItem, viaSupervisor: boolean): string {
  const head = [
    `The operator asked to STOP all work on roadmap item "${item.title}" (id ${item.id.slice(0, 8)}).`,
    'The item has been unlocked and moved back to planned. Do not write to it anymore.'
  ]
  if (viaSupervisor) {
    head.push(
      'As supervisor: relay the stop to the peers working on this item (send_message), verify they acknowledged, then report the outcome to the operator (send_message to "operator").'
    )
  } else {
    head.push(
      'If you are working on this item: stop now, leave the code in a safe state, and do not set the item in_progress again unless the operator re-dispatches it.'
    )
  }
  return head.join('\n')
}
