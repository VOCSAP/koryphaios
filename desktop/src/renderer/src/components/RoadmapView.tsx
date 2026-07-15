import { useCallback, useEffect, useState } from 'react'
import type {
  RoadmapItem,
  RoadmapKind,
  RoadmapLevel,
  RoadmapPriority,
  RoadmapStatus
} from '@shared/types'
import { useDeck } from '../store'
import { useT, type TFn } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { CreateMenu } from './CreateMenu'

// Roadmap view (PLAN C3-M3): the project's shared backlog, grouped by MoSCoW
// priority, with operator CRUD. Data lives in the broker (roadmap:* IPC);
// agents write to the same table through their MCP tools, so the view polls
// while visible to pick up their changes.

const KINDS: RoadmapKind[] = ['feature', 'bug', 'debt', 'idea', 'chore']
const PRIORITIES: RoadmapPriority[] = ['must', 'should', 'could', 'wont']
const LEVELS: RoadmapLevel[] = ['low', 'medium', 'high']
const STATUSES: RoadmapStatus[] = ['idea', 'planned', 'in_progress', 'done']
const POLL_MS = 5000

const KIND_ICONS: Record<RoadmapKind, string> = {
  feature: '✨',
  bug: '🐞',
  debt: '🧱',
  idea: '💡',
  chore: '🧹'
}

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
  tags: string
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
    tags: i.tags.join(', ')
  }
}

function ItemCard({
  item,
  selected,
  onSelect,
  t
}: {
  item: RoadmapItem
  selected: boolean
  onSelect: () => void
  t: TFn
}): React.JSX.Element {
  return (
    <button
      className={`rm-card${selected ? ' rm-card-selected' : ''}${item.status === 'archived' ? ' rm-card-archived' : ''}`}
      onClick={onSelect}
    >
      <span className="rm-card-head">
        <span className="rm-kind" title={t(`roadmap.kind.${item.kind}`)}>
          {KIND_ICONS[item.kind]}
        </span>
        <span className="rm-title">{item.title}</span>
      </span>
      <span className="rm-badges">
        <span className={`rm-badge rm-badge-value-${item.value}`}>
          {t('roadmap.value')}: {t(`roadmap.level.${item.value}`)}
        </span>
        <span className={`rm-badge rm-badge-effort-${item.effort}`}>
          {t('roadmap.effort')}: {t(`roadmap.level.${item.effort}`)}
        </span>
        <span className={`rm-badge rm-badge-status-${item.status}`}>
          {t(`roadmap.status.${item.status}`)}
        </span>
        {item.tags.map((tag) => (
          <span key={tag} className="rm-badge rm-badge-tag">
            #{tag}
          </span>
        ))}
      </span>
    </button>
  )
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
    '',
    'Use roadmap_get for full context. The item is being marked in_progress; set it to done with roadmap_update when the work is complete (or add follow-up items if you discover more).'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

export function RoadmapView(): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const setView = useDeck((s) => s.setView)

  const [items, setItems] = useState<RoadmapItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [kindFilter, setKindFilter] = useState<'' | RoadmapKind>('')
  const [showArchived, setShowArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Form state: null = closed; a Draft without id = create; with id = edit.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmArchive, setConfirmArchive] = useState<RoadmapItem | null>(null)
  // Item the "launch an agent" flow is spawning for (advanced create pre-filled).
  const [launchItem, setLaunchItem] = useState<RoadmapItem | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.roadmapList({
        kind: kindFilter || undefined,
        include_archived: showArchived
      })
      setItems(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [kindFilter, showArchived])

  // Initial load + poll while the view is visible (agents may write any time).
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const selected = items.find((i) => i.id === selectedId) ?? null

  const save = async (): Promise<void> => {
    if (!draft || !draft.title.trim()) return
    const tags = draft.tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
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
        tags
      })
      setDraft(null)
      setSelectedId(saved.id)
      showToast('toast.roadmapSaved')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const archive = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapArchive(item.id)
      showToast('toast.roadmapArchived', 'info')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const restore = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, status: 'planned' })
      showToast('toast.roadmapSaved')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const sections = PRIORITIES.map((p) => ({
    priority: p,
    rows: items.filter((i) => i.priority === p)
  }))

  return (
    <div className="roadmap-view">
      <header className="roadmap-head">
        <h2>{t('roadmap.title')}</h2>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as '' | RoadmapKind)}
          title={t('roadmap.filterKind')}
        >
          <option value="">{t('roadmap.allKinds')}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_ICONS[k]} {t(`roadmap.kind.${k}`)}
            </option>
          ))}
        </select>
        <label className="roadmap-archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>{t('roadmap.showArchived')}</span>
        </label>
        <span className="roadmap-spacer" />
        <button
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
        <button className="primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          {t('roadmap.add')}
        </button>
      </header>

      {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}

      <div className="roadmap-body">
        <div className="roadmap-list">
          {loaded && items.length === 0 && !error && (
            <p className="roadmap-empty">{t('roadmap.empty')}</p>
          )}
          {sections.map(
            ({ priority, rows }) =>
              rows.length > 0 && (
                <section key={priority} className="rm-section">
                  <h3 className={`rm-section-head rm-prio-${priority}`}>
                    {t(`roadmap.priority.${priority}`)}
                    <span className="rm-count">{rows.length}</span>
                  </h3>
                  {rows.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      selected={item.id === selectedId}
                      onSelect={() => setSelectedId(item.id === selectedId ? null : item.id)}
                      t={t}
                    />
                  ))}
                </section>
              )
          )}
        </div>

        {selected && !draft && (
          <aside className="roadmap-detail">
            <header className="rm-detail-head">
              <span className="rm-kind">{KIND_ICONS[selected.kind]}</span>
              <h3>{selected.title}</h3>
              <button className="icon-btn" title={t('common.close')} onClick={() => setSelectedId(null)}>
                ✕
              </button>
            </header>
            <div className="rm-detail-badges">
              <span className={`rm-badge rm-prio-${selected.priority}`}>
                {t(`roadmap.priority.${selected.priority}`)}
              </span>
              <span className={`rm-badge rm-badge-value-${selected.value}`}>
                {t('roadmap.value')}: {t(`roadmap.level.${selected.value}`)}
              </span>
              <span className={`rm-badge rm-badge-effort-${selected.effort}`}>
                {t('roadmap.effort')}: {t(`roadmap.level.${selected.effort}`)}
              </span>
              <span className={`rm-badge rm-badge-status-${selected.status}`}>
                {t(`roadmap.status.${selected.status}`)}
              </span>
            </div>
            {selected.description && <p className="rm-detail-text">{selected.description}</p>}
            {selected.rationale && (
              <p className="rm-detail-text rm-detail-rationale">{selected.rationale}</p>
            )}
            <p className="rm-detail-meta">
              {t('roadmap.createdBy', { name: selected.created_by, date: selected.created_at })}
              <br />
              {t('roadmap.updatedBy', { name: selected.updated_by, date: selected.updated_at })}
            </p>
            <div className="rm-detail-actions">
              {selected.status !== 'archived' && (
                <button className="primary" onClick={() => setLaunchItem(selected)}>
                  {t('roadmap.launchAgent')}
                </button>
              )}
              <button onClick={() => setDraft(toDraft(selected))}>{t('common.edit')}</button>
              {selected.status === 'archived' ? (
                <button onClick={() => void restore(selected)}>{t('roadmap.restore')}</button>
              ) : (
                <button className="danger" onClick={() => setConfirmArchive(selected)}>
                  {t('roadmap.archive')}
                </button>
              )}
            </div>
          </aside>
        )}

        {draft && (
          <aside className="roadmap-detail">
            <header className="rm-detail-head">
              <h3>{draft.id ? t('roadmap.editTitle') : t('roadmap.createTitle')}</h3>
              <button className="icon-btn" title={t('common.close')} onClick={() => setDraft(null)}>
                ✕
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
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as RoadmapKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_ICONS[k]} {t(`roadmap.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
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
              {draft.status !== 'archived' && (
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
            <label className="field">
              <span>{t('roadmap.fieldDescription')}</span>
              <textarea
                rows={3}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('roadmap.fieldRationale')}</span>
              <textarea
                rows={2}
                value={draft.rationale}
                onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('roadmap.fieldTags')}</span>
              <input
                value={draft.tags}
                placeholder={t('roadmap.fieldTagsPlaceholder')}
                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setDraft(null)}>{t('common.cancel')}</button>
              <button className="primary" disabled={!draft.title.trim()} onClick={() => void save()}>
                {draft.id ? t('roadmap.save') : t('roadmap.create')}
              </button>
            </div>
          </aside>
        )}
      </div>

      {launchItem && (
        <CreateMenu
          onClose={() => setLaunchItem(null)}
          initial={{
            prompt: composeItemPrompt(launchItem),
            announce: t('roadmap.launchAnnounce', { title: launchItem.title })
          }}
          onCreate={() => {
            // Immediate feedback: flag the item in_progress (the agent keeps it
            // current afterwards via its roadmap tools) and show the new tile.
            void window.api
              .roadmapUpsert({ id: launchItem.id, status: 'in_progress' })
              .then(() => refresh())
              .catch(() => undefined)
            setView('agents')
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
    </div>
  )
}
