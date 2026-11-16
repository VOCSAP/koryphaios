export interface DispatchCardView {
  id: string
  title: string
  kind: string
  priority: string
  value: string
  effort: string
  status: string
  description: string
  rationale: string
  context: string
  tags: readonly string[]
  depends_on: readonly string[]
}

export const NO_LEAD_NOTE = '(No team-lead is designated; you are the only active session.)'

export function itemSnapshotLines(item: DispatchCardView): string[] {
  return [
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort} | Status: ${item.status}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    item.tags.length ? `Tags: ${item.tags.join(', ')}` : '',
    item.depends_on.length ? `Depends on: ${item.depends_on.map((d) => d.slice(0, 8)).join(', ')}` : ''
  ]
}

export function composeDispatchText(item: DispatchCardView): string {
  const lines = [
    `Next roadmap item from the operator's dispatch queue (id ${item.id.slice(0, 8)}):`,
    '',
    ...itemSnapshotLines(item),
    '',
    'As team-lead: take it yourself or brief another peer with send_message. Use roadmap_get for full context, set the item in_progress with roadmap_update when the work REALLY starts (this locks it under the working peer), done when complete. Keep its status current — the Deck auto-dispatches the next queued item when this one is done.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

export function composeMultiDispatchText(items: readonly DispatchCardView[]): string {
  if (items.length <= 1) return composeDispatchText(items[0]!)
  const lines: string[] = [
    `${items.length} roadmap items from the operator's dispatch queue, to process IN PARALLEL (ids ${items
      .map((i) => i.id.slice(0, 8))
      .join(', ')}):`,
    ''
  ]
  items.forEach((item, i) => {
    if (i > 0) lines.push('---')
    lines.push(`[${i + 1}/${items.length}] id ${item.id.slice(0, 8)}:`, ...itemSnapshotLines(item))
  })
  lines.push(
    '',
    "As team-lead: distribute these across your team via send_message, respecting each role — you do NOT need to take them all yourself. If the team cannot absorb the parallelism, ask the SUPERVISOR (send_message) to spawn an additional agent — you have no direct spawn capability. Use roadmap_get for full context on each item, set an item in_progress with roadmap_update when work REALLY starts on it (this locks it under the working peer), done when complete. Keep each item's status current — the Deck auto-dispatches the next queued wave when this one fully completes."
  )
  return lines.filter((l) => l !== '').join('\n')
}

export function composeAssignText(item: DispatchCardView): string {
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

export function composeAtomicDispatchText(
  mode: 'wave' | 'assign',
  targetKind: 'lead' | 'sole-active-fallback' | 'assignee',
  cards: readonly DispatchCardView[]
): string {
  if (mode === 'assign') return composeAssignText(cards[0]!)
  const text = composeMultiDispatchText(cards)
  return targetKind === 'sole-active-fallback' ? `${text}\n${NO_LEAD_NOTE}` : text
}
