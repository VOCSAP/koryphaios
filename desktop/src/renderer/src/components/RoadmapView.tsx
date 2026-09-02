import { useEffect, useState } from 'react'
import type {
  RoadmapDirective,
  RoadmapItem,
  RoadmapKind,
  RoadmapLevel,
  RoadmapPriority,
  RoadmapStatus,
  StopResult
} from '@shared/types'
import { GLYPH_ACTIONS, GLYPH_BADGES, roleGlyph } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { CreateMenu } from './CreateMenu'
import { KIND_ICONS, RoadmapItemModal } from './RoadmapItemModal'
import { isLocked, RoadmapBoard } from './RoadmapBoard'
import { RoadmapFilterPanel } from './RoadmapFilterPanel'
import { RoadmapFilterChips } from './RoadmapFilterChips'
import { WorkflowLane } from './WorkflowLane'
import { hasActiveCriteria, useRoadmapData } from '../roadmap-data'
import { buildAppendToQueue, buildInsertIntoQueue, buildStackIntoQueue } from '@shared/workflow'

// Roadmap view (PLAN C3-M3, reworked as a kanban board in PLAN K1, split into
// container + RoadmapBoard/RoadmapFilterPanel/RoadmapFilterChips by card
// 3b0fda5f): the container keeps mutation logic/modals and the Workflow lane,
// consumes the ONE shared useRoadmapData() hook (roadmap-data.ts) also used
// by RoadmapList.tsx's mobile layout, and renders the board/filter pieces as
// props-driven children. Data lives in the broker (roadmap:* IPC); agents
// write to the same table through their MCP tools, so the hook polls while
// the view is mounted to pick up their changes.
//
// Movement rules (K1/K2): dropping on "done" asks for confirmation (the item
// will no longer be picked up); a locked in_progress card (an agent actively
// works on it) is greyed out and not draggable -- the operator goes through the
// ⏹ Stop button (K3) to reclaim it.

const KINDS: RoadmapKind[] = ['feature', 'bug', 'debt', 'idea', 'chore', 'directive']
const DIRECTIVES: RoadmapDirective[] = ['clear', 'compact', 'magic_compact']
const PRIORITIES: RoadmapPriority[] = ['must', 'should', 'could', 'wont']
const LEVELS: RoadmapLevel[] = ['low', 'medium', 'high']
const STATUSES: RoadmapStatus[] = ['idea', 'planned', 'in_progress', 'done']

/** Editable subset of an item, buffered in the form. */
interface Draft {
  id?: string
  title: string
  kind: RoadmapKind
  priority: RoadmapPriority
  value: RoadmapLevel
  effort: RoadmapLevel
  status: RoadmapStatus | 'archived'
  description: string
  rationale: string
  context: string
  tags: string
  /** kind 'directive' (CT5): the command + the peers it targets. */
  directive?: RoadmapDirective | null
  target_peer_ids?: string[]
  /** Workflow lane seeds: dependencies pre-wired on a lane-born draft. */
  depends_on?: string[]
  /** Queue slot the created item is inserted at (lane create flows). */
  insertAtQueue?: number
}

const EMPTY_DRAFT: Draft = {
  title: '',
  kind: 'feature',
  priority: 'could',
  value: 'medium',
  effort: 'medium',
  status: 'idea',
  description: '',
  rationale: '',
  context: '',
  tags: ''
}

function toDraft(i: RoadmapItem): Draft {
  return {
    id: i.id,
    title: i.title,
    kind: i.kind,
    priority: i.priority,
    value: i.value,
    effort: i.effort,
    status: i.status,
    description: i.description,
    rationale: i.rationale,
    context: i.context,
    tags: i.tags.join(', '),
    directive: i.directive,
    target_peer_ids: i.target_peer_ids
  }
}

/**
 * The prompt handed to an agent spawned on an item (PLAN C3-M4). English, like
 * the MCP instructions the agent already reads; it closes the loop by asking
 * the agent to keep the item's status current through its roadmap tools.
 */
function composeItemPrompt(item: RoadmapItem): string {
  const lines = [
    `Take on this roadmap item (id ${item.id.slice(0, 8)}):`,
    '',
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    '',
    'Use roadmap_get for full context. Set the item to in_progress with roadmap_update when you actually start (this locks it under your peer_id so no other session takes it), then to done when the work is complete -- or back to planned if you stop without finishing (this releases the lock). Add follow-up items if you discover more.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

export function RoadmapView(): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const setView = useDeck((s) => s.setView)
  const sessions = useDeck((s) => s.sessions)
  // Dispatch needs a live team-lead (PLAN C15); the button greys out otherwise.
  const hasLead = sessions.some((s) => s.lead && !s.supervisor && s.status !== 'exited')

  const {
    board,
    facets,
    queue,
    criteria,
    setCriteria,
    includeArchived,
    setIncludeArchived,
    refresh,
    error: fetchError,
    loaded
  } = useRoadmapData()
  // Mutation failures (upsert/archive/reorder/...) are view-local: the hook's
  // `error` only ever reflects the last fetch. Either one renders the same
  // banner (`error` below), a fetch failure just never gets cleared by a
  // successful mutation and vice versa.
  const [mutationError, setMutationError] = useState<string | null>(null)
  const error = fetchError ?? mutationError
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Form state: null = closed; a Draft without id = create; with id = edit.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmArchive, setConfirmArchive] = useState<RoadmapItem | null>(null)
  // Card f95ccfa6: the exact SHOWN population at the moment the button was
  // clicked (RoadmapBoard's own already-filtered 'done' rows) -- never
  // re-derived from `board`/`queue.all` at confirm time, so the count the
  // dialog announces is guaranteed to match what archiveAll() below actually
  // archives.
  const [confirmArchiveAll, setConfirmArchiveAll] = useState<RoadmapItem[] | null>(null)
  // Card f95ccfa6, ajout 1: the button must not stay clickable for the
  // whole duration of the loop below -- `rows` (RoadmapBoard's own filtered
  // slice) is only refreshed at the very end, so a second click before then
  // would re-fire the identical batch. Harmless (the broker's archive is
  // idempotent, COALESCE on deleted_at) but doubles the request volume for
  // nothing on a large column.
  const [archivingAll, setArchivingAll] = useState(false)
  // Drag & drop: the dragged item id + the column currently hovered (K1).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<RoadmapStatus | null>(null)
  // Drop on "done" awaits an explicit confirmation before it applies (K1).
  const [confirmDone, setConfirmDone] = useState<RoadmapItem | null>(null)
  // Operator stop on a locked item (K3), confirmed before the announce.
  const [confirmStop, setConfirmStop] = useState<RoadmapItem | null>(null)
  // Right-click context menu on a card (K6): viewport anchor + target item.
  const [menu, setMenu] = useState<{ x: number; y: number; item: RoadmapItem } | null>(null)
  // Priority quick-switch dropdown anchored under a card's chip (K7).
  const [prioMenu, setPrioMenu] = useState<{ x: number; y: number; item: RoadmapItem } | null>(null)
  // "Process now" (K6): pick a live agent (targeted announce) or spawn one.
  const [assignItem, setAssignItem] = useState<RoadmapItem | null>(null)
  // Item the "launch an agent" flow is spawning for (advanced create pre-filled).
  const [launchItem, setLaunchItem] = useState<RoadmapItem | null>(null)
  // Context wand (PLAN C21): one in-flight generation at a time.
  const [wandBusy, setWandBusy] = useState(false)
  // Workflow lane blown up to a foreground fullscreen modal.
  const [wfFull, setWfFull] = useState(false)
  // Card 442084b7 (team-lead's Q4 arbitration): the INVERSE of includeArchived
  // on purpose -- an inactive card is a deliberate operator set-aside, not a
  // lifecycle state, so it must stay VISIBLE by default (opt-OUT to hide),
  // never opt-in to reveal like archive. Plain client-side filter over
  // `board` below; the broker already sends `inactive` on every item, so no
  // query/broker change is needed.
  const [hideInactive, setHideInactive] = useState(false)
  // Fold state lives in AppConfig, not local state, so it does not reset (and
  // silently reopen a closed panel) at every launch; the panel itself owns the
  // toggle now.
  const filtersFolded = useDeck((s) => s.roadmapFiltersCollapsed)
  const setFiltersFolded = useDeck((s) => s.setRoadmapFiltersCollapsed)

  // Files-view seed (PLAN GX8): open the create form prefilled with the code
  // selection. Saving stays an explicit operator action (wand-style contract).
  const roadmapSeed = useDeck((s) => s.roadmapSeed)
  const clearRoadmapSeed = useDeck((s) => s.clearRoadmapSeed)
  useEffect(() => {
    if (!roadmapSeed) return
    setDraft({
      ...EMPTY_DRAFT,
      status: 'planned',
      priority: 'should',
      ...roadmapSeed
    })
    clearRoadmapSeed()
  }, [roadmapSeed, clearRoadmapSeed])

  const selected = queue.all.find((i) => i.id === selectedId) ?? null

  const save = async (): Promise<void> => {
    if (!draft || !draft.title.trim()) return
    const tags = draft.tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const isDirective = draft.kind === 'directive'
    try {
      const saved = await window.api.roadmapUpsert({
        id: draft.id,
        title: draft.title.trim(),
        kind: draft.kind,
        priority: draft.priority,
        value: draft.value,
        effort: draft.effort,
        // 'archived' is only reachable through the Archive button, not the form.
        status: draft.status === 'archived' ? undefined : draft.status,
        description: draft.description,
        rationale: draft.rationale,
        context: draft.context,
        tags,
        depends_on: draft.depends_on,
        // Directive card fields (CT5): send only for a directive kind; switching
        // a card AWAY from directive sends directive:null so the broker clears it.
        directive: isDirective ? (draft.directive ?? 'clear') : null,
        target_peer_ids: isDirective ? (draft.target_peer_ids ?? []) : undefined
      })
      // Lane-born draft: slot the new item into the queue where it was dropped
      // (nothing was written before Save, so Cancel really created nothing).
      // buildInsertIntoQueue preserves existing wave ties -- see its doc
      // comment in shared/workflow.ts.
      if (draft.id === undefined && draft.insertAtQueue !== undefined) {
        const payload = buildInsertIntoQueue(queue, saved.id, draft.insertAtQueue)
        await window.api.roadmapReorder(payload.ids, payload.waves)
      }
      setDraft(null)
      // Card f11e9e6a: a CREATION never opens the detail modal -- the operator
      // just wrote the card, printing it back to them costs a click to dismiss.
      // The rule is uniform across the three creation paths (Add button,
      // lane-born draft, roadmapSeed), so no branch per path is needed: the
      // `draft.id` discriminant already separates creation from edition, and an
      // EDIT still returns to the detail it was opened from.
      // The toast is what REPLACES the detail as the acknowledgement, so it may
      // not stay generic: it names the card, which is also what keeps a
      // freshly created card findable when it lands off-screen or under a
      // filter. `showToast` carries a bare i18n key with no params channel, so
      // the interpolated text goes through its existing raw-text path.
      if (draft.id === undefined) {
        showToast(t('toast.roadmapCreated', { title: draft.title.trim() }), 'success', {
          raw: true
        })
      } else {
        setSelectedId(saved.id)
        showToast('toast.roadmapSaved')
      }
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  const archive = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapArchive(item.id)
      showToast('toast.roadmapArchived', 'info')
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // Sequential requests, not batched: /roadmap/archive takes one id at a time,
  // so each item is issued independently — a failure on one must not abort the
  // rest, and every failure is both logged and surfaced as an honest count
  // naming which cards did not move.
  // The Deck's own writes are exempt from the in-progress lock guard, so a card
  // claimed by an agent between the click and this item's turn in the loop
  // still archives successfully with no failure entry, and unlocks it under the
  // agent — documented, not fixed.
  // The staleness window grows with the loop: on a large column, the last item
  // archives on a decision made as many round-trips earlier as there are items
  // ahead of it.
  const archiveAll = async (items: RoadmapItem[]): Promise<void> => {
    setArchivingAll(true)
    const ok: RoadmapItem[] = []
    const failed: { item: RoadmapItem; error: string }[] = []
    try {
      for (const item of items) {
        try {
          await window.api.roadmapArchive(item.id)
          ok.push(item)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          failed.push({ item, error: msg })
          window.api.reportError('roadmap:archive-all', `${item.title}: ${msg}`)
        }
      }
      if (failed.length === 0) {
        showToast(t('toast.roadmapArchivedAll', { count: ok.length }), 'info', { raw: true })
      } else {
        // Card f95ccfa6, AC1 (review round 2): `setMutationError` alone is
        // NOT enough here. `error = fetchError ?? mutationError` in this
        // component means a `refresh()` failure right after this call
        // OVERWRITES this message on screen with a generic "broker
        // unreachable" -- the one message naming which cards moved would
        // vanish exactly in the failure mode most likely to trigger it (the
        // broker dying mid-loop). A raw error toast is a SEPARATE piece of
        // state `refresh()` cannot touch -- same precedent as store.ts's
        // `guarded()` wrapper, built for the identical reason (PLAN O6).
        showToast(
          t('roadmap.archiveAllPartialFailure', {
            ok: ok.length,
            failed: failed.length,
            titles: failed.map((f) => f.item.title).join(', ')
          }),
          'error',
          { raw: true }
        )
      }
      await refresh()
    } finally {
      setArchivingAll(false)
    }
  }

  const restore = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, status: 'planned' })
      showToast('toast.roadmapSaved')
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // Dispatch queue (PLAN C15): the Workflow lane below the board renders it.
  const setQueue = async (item: RoadmapItem, queue: number | null): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, queue })
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // ----- workflow lane (graphical dispatch queue) -----

  // waves is optional -- WorkflowLane's own onReorder computes its join-aware
  // grouping and passes it through; callers with no wave opinion (a plain
  // clear, or a caller that already merged waves into `ids` itself) omit it.
  const reorderQueue = async (ids: string[], waves?: string[][]): Promise<void> => {
    try {
      await window.api.roadmapReorder(ids, waves)
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // Appends item to the end of the queue, pulling its unmet, unqueued
  // dependencies along with it in the same reorder commit -- the modal's
  // "add to queue" entry point, alongside WorkflowLane's commitDrop, both
  // funnel through buildAppendToQueue so a card can never reach the queue
  // without what it depends on.
  const queueItem = (item: RoadmapItem): Promise<void> => {
    const payload = buildAppendToQueue(queue, item.id)
    return reorderQueue(payload.ids, payload.waves)
  }

  const addDep = async (childId: string, parentId: string): Promise<void> => {
    const child = queue.all.find((i) => i.id === childId)
    if (!child || child.depends_on.includes(parentId)) return
    try {
      await window.api.roadmapUpsert({ id: childId, depends_on: [...child.depends_on, parentId] })
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeDep = async (childId: string, parentId: string): Promise<void> => {
    const child = queue.all.find((i) => i.id === childId)
    if (!child) return
    try {
      await window.api.roadmapUpsert({
        id: childId,
        depends_on: child.depends_on.filter((d) => d !== parentId)
      })
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Stack gesture (parallel siblings): the dragged card adopts the target's
   * dependencies; a card stacked in from the board joins the queue right
   * after its new sibling.
   */
  const stackItem = async (
    dragId: string,
    targetId: string,
    dependsOn: string[]
  ): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: dragId, depends_on: dependsOn })
      const item = queue.all.find((i) => i.id === dragId)
      if (item && item.queue === null) {
        // Stacking never lands INSIDE an existing wave -- buildStackIntoQueue
        // rounds to the boundary right after the target's WHOLE wave (see its
        // doc comment in shared/workflow.ts).
        const payload = buildStackIntoQueue(queue, dragId, targetId, 'after')
        await window.api.roadmapReorder(payload.ids, payload.waves)
      }
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Lane create flows (right-click / link into the void): prefilled draft. */
  const createAt = (queueIndex: number, dependsOn: string[]): void => {
    setDraft({
      ...EMPTY_DRAFT,
      status: 'planned',
      priority: 'should',
      depends_on: dependsOn,
      insertAtQueue: queueIndex
    })
  }

  // Context wand (PLAN C21): a read-only haiku pass drafts the briefing from
  // the item + the project files. It only fills the textarea (still editable);
  // nothing is saved until the operator hits Save.
  const wand = async (): Promise<void> => {
    if (!draft || wandBusy) return
    setWandBusy(true)
    try {
      const proposed = await window.api.roadmapWand({
        title: draft.title,
        kind: draft.kind,
        description: draft.description,
        rationale: draft.rationale,
        context: draft.context
      })
      // The draft may have been closed while the wand ran: drop the result.
      setDraft((d) => (d ? { ...d, context: proposed } : d))
      setMutationError(null)
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    } finally {
      setWandBusy(false)
    }
  }

  const dispatch = async (): Promise<void> => {
    const r = await window.api.roadmapDispatch()
    if (r.sent) showToast('toast.dispatched')
    else showToast(r.reason === 'no-lead' ? 'toast.dispatchNoLead' : 'toast.dispatchFailed', 'info')
    await refresh()
  }

  // ----- kanban moves (K1) -----

  const applyMove = async (item: RoadmapItem, status: RoadmapStatus): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, status })
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  const moveItem = (item: RoadmapItem, status: RoadmapStatus): void => {
    if (item.status === status || isLocked(item)) return
    if (status === 'done') setConfirmDone(item)
    else void applyMove(item, status)
  }

  const dropOn = (status: RoadmapStatus): void => {
    const item = queue.all.find((i) => i.id === dragId) ?? null
    setDragId(null)
    setDropCol(null)
    if (item) moveItem(item, status)
  }

  // ----- operator stop (K3) -----

  const stop = async (item: RoadmapItem): Promise<void> => {
    try {
      const r: StopResult = await window.api.roadmapStop(item.id)
      if (!r.stopped) showToast('toast.stopFailed', 'info')
      else if (r.via === 'supervisor') showToast('toast.stopSupervisor')
      else if (r.via === 'broadcast') showToast('toast.stopBroadcast')
      else showToast('toast.stopNoPeers', 'info')
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // Priority quick-switch (K7): metadata write, allowed even on locked items
  // (the broker guard only protects status / lock claims).
  const setPriority = async (item: RoadmapItem, priority: RoadmapPriority): Promise<void> => {
    setPrioMenu(null)
    if (item.priority === priority) return
    try {
      await window.api.roadmapUpsert({ id: item.id, priority })
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // The operator proof the broker's refusesInactiveToggle guard requires comes
  // from going through signedAsOperator() when posting, not from the by:
  // DECK_AUTHOR stamp, which an unsigned caller could send too.
  // This call (id/inactive only) cannot itself trip refusesInactiveClaim or
  // refusesInactiveQueue: it sends no queue field, and the lock resolver only
  // forces locked to false in the releasing direction when nextStatus stays
  // unchanged from in_progress, never claims one.
  // A failure still surfaces like any other, through the ordinary
  // network/broker-down channel — never swallowed.
  const toggleInactive = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, inactive: !item.inactive })
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // ----- direct assignment (K6) -----

  // Live, addressable agents: peer_id resolved, not the supervisor.
  const liveAgents = sessions.filter((s) => !s.supervisor && s.status !== 'exited' && s.peerId)
  // Directive cards (CT5): a directive card targets peers, not work attributes,
  // so the form swaps the priority/value/effort/context fields for a directive
  // dropdown + a peer multiselect. `toggleTarget` flips one peer in the set.
  const draftIsDirective = draft?.kind === 'directive'
  const toggleTarget = (peerId: string): void => {
    setDraft((d) => {
      if (!d) return d
      const cur = d.target_peer_ids ?? []
      return {
        ...d,
        target_peer_ids: cur.includes(peerId)
          ? cur.filter((p) => p !== peerId)
          : [...cur, peerId]
      }
    })
  }

  const assign = async (item: RoadmapItem, peerId: string): Promise<void> => {
    setAssignItem(null)
    try {
      const r = await window.api.roadmapAssign(item.id, peerId)
      showToast(r.sent ? 'toast.assignSent' : 'toast.assignFailed', r.sent ? 'success' : 'info')
      await refresh()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }

  // ----- card context menu (K6) -----

  const menuItems = (item: RoadmapItem): ContextMenuItem[] => {
    const locked = isLocked(item)
    const closed = item.status === 'done' || item.status === 'archived'
    const archived = item.status === 'archived'

    // Card 99d3a9eb, arbitrage 3: the one action that survives on every
    // closed card, built ONCE so the label/icon fix (was the trash glyph +
    // roadmap.menuDelete on an action that actually calls setConfirmArchive
    // -- card's own measurement) lives in a single place instead of drifting
    // between the open- and closed-card branches below. `disabled: locked`
    // is dead code today (isLocked() requires status==='in_progress', never
    // true together with 'done'/'archived') but kept so this entry inherits
    // the lockedHint discipline for free if that invariant ever loosens.
    const archiveOrRestoreItem: ContextMenuItem = archived
      ? {
          label: (
            <>
              {GLYPH_ACTIONS.restore} {t('roadmap.restore')}
            </>
          ),
          disabled: locked,
          onSelect: () => void restore(item)
        }
      : {
          label: (
            <>
              {GLYPH_BADGES.archive} {t('roadmap.archive')}
            </>
          ),
          danger: true,
          disabled: locked,
          onSelect: () => setConfirmArchive(item)
        }

    // Arbitrage 1: MASKED, not disabled -- a closed card offers exactly one
    // entry, never the other four greyed out. Arbitrage 3's criterion: every
    // action that advances/modifies the card disappears; only its own
    // cycle-of-life action (Archive on done, Restore on archived) survives.
    // The archived branch here closes a coverage gap the card's own
    // measurement did not enumerate for this surface (only the modal was
    // measured as already correct for Restore) -- same criterion, applied
    // to the one surface it missed.
    if (closed) {
      return [archiveOrRestoreItem]
    }

    return [
      {
        label: (
          <>
            {GLYPH_ACTIONS.edit} {t('roadmap.menuEdit')}
          </>
        ),
        disabled: locked,
        onSelect: () => setDraft(toDraft(item))
      },
      item.queue !== null
        ? {
            label: t('roadmap.queueRemove'),
            disabled: locked,
            onSelect: () => void setQueue(item, null)
          }
        : {
            label: (
              <>
                {GLYPH_BADGES.clepsydra} {t('roadmap.menuQueue')}
              </>
            ),
            disabled: locked,
            onSelect: () => void queueItem(item)
          },
      {
        label: (
          <>
            {GLYPH_ACTIONS.forward} {t('roadmap.menuAssign')}
          </>
        ),
        disabled: locked,
        onSelect: () => setAssignItem(item)
      },
      {
        label: (
          <>
            {item.inactive ? GLYPH_BADGES.torchLit : GLYPH_BADGES.torchOut}{' '}
            {t(item.inactive ? 'roadmap.menuReactivate' : 'roadmap.menuMarkInactive')}
          </>
        ),
        disabled: locked,
        onSelect: () => void toggleInactive(item)
      },
      archiveOrRestoreItem
    ]
  }

  return (
    <div className="roadmap-view">
      <header className="roadmap-head">
        <h2>{t('roadmap.title')}</h2>
        <span className="roadmap-spacer" />
        <button
          className="btn"
          onClick={() => {
            void window.api.importPlan().then((spawned) => {
              if (spawned) {
                showToast('toast.planImportStarted')
                setView('agents')
              }
            })
          }}
        >
          {t('roadmap.importPlan')}
        </button>
        {/* Card 7a2e76c6: the fold control used to sit HERE, between "Import a
            plan" and "Add" -- a display setting filed among actions on the
            data, which is what made it read as "close the view" and made it
            something to hunt for. It now lives on the panel it commands
            (RoadmapFilterPanel's head), the shipped pattern of the Agents
            sidebar. This row carries actions only. */}
        <button className="primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          {t('roadmap.add')}
        </button>
      </header>

      <RoadmapFilterChips
        criteria={criteria}
        setCriteria={setCriteria}
        includeArchived={includeArchived}
        setIncludeArchived={setIncludeArchived}
        hideInactive={hideInactive}
        setHideInactive={setHideInactive}
        hiddenInactiveCount={hideInactive ? board.filter((i) => i.inactive).length : 0}
        t={t}
      />

      <div className="roadmap-body">
        <RoadmapFilterPanel
          criteria={criteria}
          setCriteria={setCriteria}
          facets={facets}
          includeArchived={includeArchived}
          setIncludeArchived={setIncludeArchived}
          folded={filtersFolded}
          onToggleFold={() => setFiltersFolded(!filtersFolded)}
          t={t}
        />

        <div className="roadmap-main">
          <RoadmapBoard
            items={hideInactive ? board.filter((i) => !i.inactive) : board}
            showArchived={includeArchived}
            // Card 442084b7 review B1: hideInactive is a THIRD filter
            // dimension alongside `criteria`/includeArchived and must count
            // as "active" everywhere the others do -- omitting it here was
            // the exact D1 regression (a narrow filter making the board look
            // fully empty with no explanation) this prop exists to prevent.
            hasActiveFilters={hasActiveCriteria(criteria) || hideInactive}
            onClearFilters={() => {
              setCriteria({})
              setHideInactive(false)
            }}
            loaded={loaded}
            error={error}
            dragId={dragId}
            dropCol={dropCol}
            onDragStartItem={(item) => setDragId(item.id)}
            onDragEndItem={() => {
              setDragId(null)
              setDropCol(null)
            }}
            onDragOverCol={(status) => setDropCol(status)}
            onDragLeaveCol={(status) => setDropCol((c) => (c === status ? null : c))}
            onDropCol={dropOn}
            onOpen={(item) => setSelectedId(item.id)}
            onMenu={(item, x, y) => setMenu({ x, y, item })}
            onPrio={(item, x, y) => setPrioMenu({ x, y, item })}
            onArchiveAll={(items) => items.length > 0 && setConfirmArchiveAll(items)}
            archiveAllBusy={archivingAll}
            t={t}
          />

          {/* Workflow lane (bottom half): the dispatch queue as a visual chain —
              cards top, execution order below, per the operator's mental model. */}
          {!wfFull && (
            <WorkflowLane
              source={queue}
              hasLead={hasLead}
              onToggleFull={() => setWfFull(true)}
              onDispatch={() => void dispatch()}
              onOpen={(id) => setSelectedId(id)}
              onMenu={(item, x, y) => setMenu({ x, y, item })}
              onReorder={(ids, waves) => void reorderQueue(ids, waves)}
              onCreateAt={createAt}
              onAddDep={(childId, parentId) => void addDep(childId, parentId)}
              onRemoveDep={(childId, parentId) => void removeDep(childId, parentId)}
              onStack={(dragId, targetId, deps) => void stackItem(dragId, targetId, deps)}
            />
          )}
        </div>
      </div>

      {wfFull && (
        <div className="modal-backdrop" onMouseDown={() => setWfFull(false)}>
          <div className="wf-modal" onMouseDown={(e) => e.stopPropagation()}>
            <WorkflowLane
              source={queue}
              hasLead={hasLead}
              fullscreen
              onToggleFull={() => setWfFull(false)}
              onDispatch={() => void dispatch()}
              onOpen={(id) => setSelectedId(id)}
              onMenu={(item, x, y) => setMenu({ x, y, item })}
              onReorder={(ids, waves) => void reorderQueue(ids, waves)}
              onCreateAt={createAt}
              onAddDep={(childId, parentId) => void addDep(childId, parentId)}
              onRemoveDep={(childId, parentId) => void removeDep(childId, parentId)}
              onStack={(dragId, targetId, deps) => void stackItem(dragId, targetId, deps)}
            />
          </div>
        </div>
      )}

      {selected && !draft && (
        <RoadmapItemModal
          item={selected}
          items={queue.all}
          onClose={() => setSelectedId(null)}
          onEdit={() => setDraft(toDraft(selected))}
          onLaunch={() => setLaunchItem(selected)}
          onStop={() => setConfirmStop(selected)}
          onQueue={() => void queueItem(selected)}
          onUnqueue={() => void setQueue(selected, null)}
          onArchive={() => setConfirmArchive(selected)}
          onRestore={() => void restore(selected)}
          onAddDep={(parentId) => void addDep(selected.id, parentId)}
          onRemoveDep={(parentId) => void removeDep(selected.id, parentId)}
        />
      )}

      {draft && (
        <div className="modal-backdrop" onMouseDown={() => setDraft(null)}>
          <aside className="modal rm-modal rm-modal-form" onMouseDown={(e) => e.stopPropagation()}>
            <header className="rm-detail-head">
              <h3>{draft.id ? t('roadmap.editTitle') : t('roadmap.createTitle')}</h3>
              <button className="icon-btn" title={t('common.close')} onClick={() => setDraft(null)}>
                {GLYPH_ACTIONS.close}
              </button>
            </header>
            <label className="field">
              <span>{t('roadmap.fieldTitle')}</span>
              <input
                value={draft.title}
                autoFocus
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>{t('roadmap.fieldKind')}</span>
                <select
                  value={draft.kind}
                  onChange={(e) => {
                    const kind = e.target.value as RoadmapKind
                    // Switching to a directive seeds a default command so the
                    // card is always coherent (broker requires one).
                    setDraft({
                      ...draft,
                      kind,
                      directive: kind === 'directive' ? (draft.directive ?? 'clear') : draft.directive
                    })
                  }}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_ICONS[k]} {t(`roadmap.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              {draftIsDirective ? (
                <label className="field">
                  <span>{t('roadmap.fieldDirective')}</span>
                  <select
                    value={draft.directive ?? 'clear'}
                    onChange={(e) =>
                      setDraft({ ...draft, directive: e.target.value as RoadmapDirective })
                    }
                  >
                    {DIRECTIVES.map((d) => (
                      <option key={d} value={d}>
                        {t(`roadmap.directive.${d}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="field">
                    <span>{t('roadmap.fieldPriority')}</span>
                    <select
                      value={draft.priority}
                      onChange={(e) =>
                        setDraft({ ...draft, priority: e.target.value as RoadmapPriority })
                      }
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {t(`roadmap.priority.${p}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t('roadmap.value')}</span>
                    <select
                      value={draft.value}
                      onChange={(e) => setDraft({ ...draft, value: e.target.value as RoadmapLevel })}
                    >
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {t(`roadmap.level.${l}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t('roadmap.effort')}</span>
                    <select
                      value={draft.effort}
                      onChange={(e) => setDraft({ ...draft, effort: e.target.value as RoadmapLevel })}
                    >
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {t(`roadmap.level.${l}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {!draftIsDirective && draft.status !== 'archived' && (
                <label className="field">
                  <span>{t('roadmap.fieldStatus')}</span>
                  <select
                    value={draft.status}
                    onChange={(e) => setDraft({ ...draft, status: e.target.value as RoadmapStatus })}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`roadmap.status.${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {draftIsDirective && (
              <div className="field rm-directive-targets">
                <span>{t('roadmap.fieldTargets')}</span>
                {liveAgents.length === 0 ? (
                  <p className="rm-directive-empty">{t('roadmap.targetsEmpty')}</p>
                ) : (
                  <div className="rm-target-list">
                    {liveAgents.map((s) => {
                      const on = (draft.target_peer_ids ?? []).includes(s.peerId!)
                      // The agent NAME is what the operator recognises, but the
                      // peer id stays visible underneath: it is the routing key
                      // and the only discriminator when two agents share a
                      // display name. No name (or name === peer id): id alone.
                      const named = !!s.name && s.name !== s.peerId
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`btn rm-target-chip${on ? ' is-on' : ''}`}
                          aria-pressed={on}
                          onClick={() => toggleTarget(s.peerId!)}
                        >
                          {on ? GLYPH_ACTIONS.check : GLYPH_BADGES.profile}
                          <span className="rm-target-labels">
                            <span className="rm-target-name">
                              {named ? s.name : s.peerId}
                            </span>
                            {named && <span className="rm-target-peer">{s.peerId}</span>}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
                <p className="rm-directive-hint">{t('roadmap.directiveHint')}</p>
              </div>
            )}
            <label className="field">
              <span>{t('roadmap.fieldDescription')}</span>
              <textarea
                rows={draftIsDirective ? 2 : 3}
                value={draft.description}
                placeholder={draftIsDirective ? t('roadmap.directiveNotePlaceholder') : undefined}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            {!draftIsDirective && (
              <>
                <label className="field">
                  <span>{t('roadmap.fieldRationale')}</span>
                  <textarea
                    rows={2}
                    value={draft.rationale}
                    onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
                  />
                </label>
                <label className="field rm-context-field">
                  <span className="rm-context-label">
                    {t('roadmap.fieldContext')}
                    <button
                      type="button"
                      className="icon-btn rm-wand-btn"
                      title={t('roadmap.wandTitle')}
                      disabled={wandBusy || !draft.title.trim()}
                      onClick={() => void wand()}
                    >
                      {wandBusy ? GLYPH_BADGES.clepsydra : GLYPH_ACTIONS.wand}
                    </button>
                  </span>
                  <textarea
                    rows={6}
                    value={draft.context}
                    placeholder={t('roadmap.fieldContextPlaceholder')}
                    disabled={wandBusy}
                    onChange={(e) => setDraft({ ...draft, context: e.target.value })}
                  />
                  {wandBusy && <span className="rm-wand-hint">{t('roadmap.wandBusy')}</span>}
                </label>
                <label className="field">
                  <span>{t('roadmap.fieldTags')}</span>
                  <input
                    value={draft.tags}
                    placeholder={t('roadmap.fieldTagsPlaceholder')}
                    onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  />
                </label>
              </>
            )}
            <div className="modal-actions">
              <button onClick={() => setDraft(null)}>{t('common.cancel')}</button>
              <button className="primary" disabled={!draft.title.trim()} onClick={() => void save()}>
                {draft.id ? t('roadmap.save') : t('roadmap.create')}
              </button>
            </div>
          </aside>
        </div>
      )}

      {launchItem && (
        <CreateMenu
          onClose={() => setLaunchItem(null)}
          initial={{
            prompt: composeItemPrompt(launchItem),
            announce: t('roadmap.launchAnnounce', { title: launchItem.title })
          }}
          onCreate={() => {
            // Immediate feedback: flag the item in_progress (the agent locks it
            // and keeps it current afterwards via its roadmap tools).
            void window.api
              .roadmapUpsert({ id: launchItem.id, status: 'in_progress' })
              .then(() => refresh())
              .catch(() => undefined)
            setView('agents')
          }}
        />
      )}

      {confirmDone && (
        <ConfirmDialog
          title={t('roadmap.confirmDoneTitle')}
          message={t('roadmap.confirmDoneMessage', { title: confirmDone.title })}
          confirmLabel={t('roadmap.confirmDone')}
          onCancel={() => setConfirmDone(null)}
          onConfirm={() => {
            const item = confirmDone
            setConfirmDone(null)
            void applyMove(item, 'done')
          }}
        />
      )}

      {confirmStop && (
        <ConfirmDialog
          title={t('roadmap.confirmStopTitle')}
          message={t('roadmap.confirmStopMessage', { title: confirmStop.title })}
          confirmLabel={t('roadmap.stop')}
          onCancel={() => setConfirmStop(null)}
          onConfirm={() => {
            const item = confirmStop
            setConfirmStop(null)
            void stop(item)
          }}
        />
      )}

      {confirmArchive && (
        <ConfirmDialog
          title={t('roadmap.confirmArchiveTitle')}
          message={t('roadmap.confirmArchiveMessage', { title: confirmArchive.title })}
          confirmLabel={t('roadmap.archive')}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={() => {
            const item = confirmArchive
            setConfirmArchive(null)
            void archive(item)
          }}
        />
      )}

      {confirmArchiveAll && (
        <ConfirmDialog
          title={t('roadmap.confirmArchiveAllTitle', { count: confirmArchiveAll.length })}
          message={t('roadmap.confirmArchiveAllMessage', { count: confirmArchiveAll.length })}
          confirmLabel={t('roadmap.archive')}
          onCancel={() => setConfirmArchiveAll(null)}
          onConfirm={() => {
            const items = confirmArchiveAll
            setConfirmArchiveAll(null)
            void archiveAll(items)
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.item)}
          onClose={() => setMenu(null)}
        />
      )}

      {prioMenu && (
        <div
          className="context-menu-backdrop"
          onMouseDown={(e) => {
            e.stopPropagation()
            setPrioMenu(null)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setPrioMenu(null)
          }}
        >
          <ul
            className="context-menu rm-prio-menu"
            style={{ left: prioMenu.x, top: prioMenu.y }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {PRIORITIES.map((p) => (
              <li key={p} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={p === prioMenu.item.priority}
                  className={`context-menu-item rm-prio-option rm-prio-${p}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void setPriority(prioMenu.item, p)
                  }}
                >
                  <span className="rm-prio-dot" />
                  <span className="rm-prio-option-label">{t(`roadmap.priority.${p}`)}</span>
                  {p === prioMenu.item.priority && (
                    <span className="rm-prio-check">{GLYPH_ACTIONS.check}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {assignItem && (
        <div className="modal-backdrop" onMouseDown={() => setAssignItem(null)}>
          <div className="modal rm-assign-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header className="rm-detail-head">
              <h3>{t('roadmap.assignTitle')}</h3>
              <button
                className="icon-btn"
                title={t('common.close')}
                onClick={() => setAssignItem(null)}
              >
                {GLYPH_ACTIONS.close}
              </button>
            </header>
            <p className="rm-assign-hint">{t('roadmap.assignHint', { title: assignItem.title })}</p>
            {liveAgents.length === 0 && (
              <p className="rm-assign-empty">{t('roadmap.assignNoAgents')}</p>
            )}
            <div className="rm-assign-list">
              {liveAgents.map((s) => (
                <button
                  key={s.id}
                  className="rm-assign-row"
                  onClick={() => void assign(assignItem, s.peerId!)}
                >
                  <span className="rm-assign-dot" style={{ background: s.color }} />
                  <span className="rm-assign-name">{s.name}</span>
                  {/* Role glyph (card b5ba8cac): this dialog is where the
                      operator picks WHO to dispatch an item to, so what the
                      agent DOES is the deciding information, next to the
                      laurel that already qualifies the row. */}
                  {roleGlyph(s.role) && (
                    <span title={t('sidebar.roleTitle', { role: s.role ?? '' })}>
                      {roleGlyph(s.role)}
                    </span>
                  )}
                  {s.lead && <span title={t('sidebar.leadTitle')}>{GLYPH_BADGES.laurel}</span>}
                  <span className="rm-assign-peer">{s.peerId}</span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button onClick={() => setAssignItem(null)}>{t('common.cancel')}</button>
              <button
                className="primary"
                onClick={() => {
                  const item = assignItem
                  setAssignItem(null)
                  setLaunchItem(item)
                }}
              >
                {t('roadmap.assignNew')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
