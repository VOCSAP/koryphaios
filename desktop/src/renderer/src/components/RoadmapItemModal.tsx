import { useEffect, useMemo, useState } from 'react'
import type { RoadmapItem, RoadmapKind, SessionRuntime } from '@shared/types'
import { dependsWouldCycle } from '@shared/workflow'
import { useT, type TFn } from '../i18n'
import { useDeck } from '../store'
import { GLYPH_ACTIONS, GLYPH_BADGES, GLYPH_KINDS } from './icons'
import { parseMarkdown, type BlockToken, type InlineToken } from '../markdown'
import { ContextMenu } from './ContextMenu'

// Roadmap item detail modal (PLAN K5): the Trello-style foreground card opened
// by clicking a kanban card. Read view only -- editing stays in the form modal
// owned by RoadmapView. The markdown fields are agent-written, so rendering
// goes through the token tree of markdown.ts (React escapes every text node).

/** Kind marks: coloured stroke glyphs (GLYPH_KINDS, DESIGN.md §5). */
export const KIND_ICONS: Record<RoadmapKind, React.JSX.Element> = GLYPH_KINDS

function Inline({ tokens }: { tokens: InlineToken[] }): React.JSX.Element {
  return (
    <>
      {tokens.map((tok, i) => {
        switch (tok.t) {
          case 'bold':
            return (
              <strong key={i}>
                <Inline tokens={tok.children} />
              </strong>
            )
          case 'italic':
            return (
              <em key={i}>
                <Inline tokens={tok.children} />
              </em>
            )
          case 'code':
            return <code key={i}>{tok.text}</code>
          case 'link':
            // Agent-provided URLs are never navigated: label + href as text.
            return (
              <span key={i} className="md-link" title={tok.href}>
                {tok.label}
              </span>
            )
          default:
            return <span key={i}>{tok.text}</span>
        }
      })}
    </>
  )
}

function Block({ block }: { block: BlockToken }): React.JSX.Element {
  switch (block.t) {
    case 'heading':
      // Modal headings start under the item title: h4 for #, h5 below.
      return block.level <= 1 ? (
        <h4>
          <Inline tokens={block.children} />
        </h4>
      ) : (
        <h5>
          <Inline tokens={block.children} />
        </h5>
      )
    case 'codeblock':
      return (
        <pre className="md-code">
          <code>{block.text}</code>
        </pre>
      )
    case 'list':
      return block.ordered ? (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline tokens={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline tokens={item} />
            </li>
          ))}
        </ul>
      )
    default:
      return (
        <p>
          <Inline tokens={block.children} />
        </p>
      )
  }
}

export function Markdown({ source }: { source: string }): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  )
}

/**
 * The item's short id, the handle agents actually read and write cards by
 * (roadmap_get / roadmap_update take the 8-char form the dispatch prompt
 * inlines). Shown on the kanban card AND here so the operator can quote an id
 * from the screen instead of going through the CLI.
 *
 * A span with role="button", never a <button>: on the board this renders inside
 * the card, which is itself a <button> (nested buttons are invalid) and is
 * draggable, so a text-selection gesture would start an HTML5 drag -- hence
 * click-to-copy rather than plain selectable text. The click is stopped so it
 * never opens the card underneath.
 */
export function RoadmapItemId({ item, t }: { item: RoadmapItem; t: TFn }): React.JSX.Element {
  const showToast = useDeck((s) => s.showToast)
  const short = item.id.slice(0, 8)
  return (
    <span
      className="rm-id"
      role="button"
      title={t('roadmap.copyId')}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(short).then(
          () => showToast('toast.idCopied'),
          // Denied permission / non-secure context: never an unhandled rejection.
          (err: unknown) => window.api.reportError('roadmap', `copy id: ${String(err)}`)
        )
      }}
    >
      {short}
    </span>
  )
}

function badges(item: RoadmapItem, t: TFn): React.JSX.Element {
  return (
    <div className="rm-detail-badges">
      <RoadmapItemId item={item} t={t} />
      <span className={`rm-badge rm-prio-${item.priority}`}>
        {t(`roadmap.priority.${item.priority}`)}
      </span>
      <span className={`rm-badge rm-badge-status-${item.status}`}>
        {t(`roadmap.status.${item.status}`)}
      </span>
      <span className={`rm-badge rm-badge-value-${item.value}`}>
        {t('roadmap.value')}: {t(`roadmap.level.${item.value}`)}
      </span>
      <span className={`rm-badge rm-badge-effort-${item.effort}`}>
        {t('roadmap.effort')}: {t(`roadmap.level.${item.effort}`)}
      </span>
      {item.queue !== null && (
        <span className="rm-badge rm-badge-queue">{GLYPH_BADGES.clepsydra} #{item.queue}</span>
      )}
      {item.locked && (
        <span className="rm-badge rm-badge-locked" title={t('roadmap.lockedHint')}>
          {GLYPH_BADGES.lock} {item.locked_by}
        </span>
      )}
      {item.tags.map((tag) => (
        <span key={tag} className="rm-badge rm-badge-tag">
          #{tag}
        </span>
      ))}
    </div>
  )
}

/**
 * Display name of a directive target, or null to fall back to the raw peer_id.
 *
 * The name is what the operator recognises; the peer_id stays visible next to it
 * because it is the ROUTING key and the only discriminator when two agents share
 * a display name -- same primary/secondary split as the directive editor
 * (`.rm-target-*` in RoadmapView). A card outlives the sessions it targets, so an
 * id matching nothing (dead or foreign peer) legitimately renders alone.
 *
 * peerId is a routing key, not a primary key on THIS list: a resumed session and
 * its dormant twin can both carry it, so the lookup resolves the OBJECT first
 * (live wins, then any) instead of a Map keyed by peerId, which would silently
 * pick one of the two.
 */
function targetName(sessions: SessionRuntime[], peerId: string): string | null {
  const s =
    sessions.find((x) => x.peerId === peerId && x.status !== 'exited') ??
    sessions.find((x) => x.peerId === peerId)
  return s?.name && s.name !== peerId ? s.name : null
}

export function RoadmapItemModal({
  item,
  items,
  onClose,
  onEdit,
  onLaunch,
  onStop,
  onQueue,
  onUnqueue,
  onArchive,
  onRestore,
  onAddDep,
  onRemoveDep
}: {
  item: RoadmapItem
  items: RoadmapItem[]
  onClose: () => void
  onEdit: () => void
  onLaunch: () => void
  onStop: () => void
  onQueue: () => void
  onUnqueue: () => void
  onArchive: () => void
  onRestore: () => void
  onAddDep: (parentId: string) => void
  onRemoveDep: (parentId: string) => void
}): React.JSX.Element {
  const t = useT()
  // Directive targets are stored as peer ids; the sessions list is what names them.
  const sessions = useDeck((s) => s.sessions)
  const [depMenu, setDepMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stoppable = item.locked && item.status === 'in_progress'

  const depCandidates = items.filter(
    (i) =>
      i.id !== item.id &&
      !item.depends_on.includes(i.id) &&
      i.status !== 'done' &&
      i.status !== 'archived' &&
      !dependsWouldCycle(items, item.id, i.id)
  )

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal rm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="rm-detail-head">
          <span className="rm-kind" title={t(`roadmap.kind.${item.kind}`)}>
            {KIND_ICONS[item.kind]}
          </span>
          <h3>{item.title}</h3>
          <button
            className="icon-btn"
            title={stoppable ? t('roadmap.lockedHint') : t('common.edit')}
            disabled={stoppable}
            onClick={onEdit}
          >
            {GLYPH_ACTIONS.edit}
          </button>
          <button className="icon-btn" title={t('common.close')} onClick={onClose}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>

        {badges(item, t)}
        {item.locked && item.locked_at && (
          <p className="rm-locked-note">
            {t('roadmap.lockedSince', { name: item.locked_by ?? '', date: item.locked_at })}
          </p>
        )}

        <div className="rm-modal-body">
          {item.kind === 'directive' && (
            <section className="rm-modal-section rm-modal-directive">
              <h4>{t('roadmap.fieldDirective')}</h4>
              <p className="rm-directive-cmd">
                {t(`roadmap.directive.${item.directive ?? 'clear'}`)}
              </p>
              <h4>{t('roadmap.fieldTargets')}</h4>
              <div className="rm-detail-badges">
                {item.target_peer_ids.length === 0 ? (
                  <span className="rm-badge">{t('roadmap.targetsEmpty')}</span>
                ) : (
                  item.target_peer_ids.map((p) => {
                    const name = targetName(sessions, p)
                    return (
                      <span key={p} className="rm-badge rm-badge-target" title={p}>
                        {name ?? p}
                        {name && <span className="rm-badge-target-id">{p}</span>}
                      </span>
                    )
                  })
                )}
              </div>
            </section>
          )}
          {item.description && (
            <section className="rm-modal-section">
              <h4>{t('roadmap.fieldDescription')}</h4>
              <Markdown source={item.description} />
            </section>
          )}
          {item.rationale && (
            <section className="rm-modal-section rm-modal-rationale">
              <h4>{t('roadmap.fieldRationale')}</h4>
              <Markdown source={item.rationale} />
            </section>
          )}
          {item.context && (
            <section className="rm-modal-section rm-modal-context">
              <h4>{t('roadmap.fieldContext')}</h4>
              <Markdown source={item.context} />
            </section>
          )}
          <section className="rm-modal-section">
            <h4>{t('roadmap.dependsOn')}</h4>
            <div className="rm-dep-chips">
              {item.depends_on.map((d) => {
                const dep = items.find((i) => i.id === d)
                return (
                  <span key={d} className="rm-badge rm-dep-chip">
                    {dep ? dep.title : d.slice(0, 8)}
                    <button
                      type="button"
                      className="rm-dep-chip-x"
                      title={t('roadmap.wf.removeDep')}
                      onClick={() => onRemoveDep(d)}
                    >
                      {GLYPH_ACTIONS.close}
                    </button>
                  </span>
                )
              })}
              <button
                type="button"
                className="icon-btn rm-dep-add"
                title={t('roadmap.addDep')}
                disabled={depCandidates.length === 0}
                onClick={(e) => setDepMenu({ x: e.clientX, y: e.clientY })}
              >
                {GLYPH_ACTIONS.plus}
              </button>
            </div>
          </section>
        </div>

        <p className="rm-detail-meta">
          {t('roadmap.createdBy', { name: item.created_by, date: item.created_at })}
          <br />
          {t('roadmap.updatedBy', { name: item.updated_by, date: item.updated_at })}
        </p>

        <div className="rm-detail-actions">
          {item.status !== 'archived' && (
            <button className="primary" onClick={onLaunch} disabled={stoppable}>
              {t('roadmap.launchAgent')}
            </button>
          )}
          {stoppable && (
            <button className="btn danger" onClick={onStop}>
              {t('roadmap.stop')}
            </button>
          )}
          {item.status !== 'archived' &&
            item.status !== 'done' &&
            (item.queue === null ? (
              <button className="btn" onClick={onQueue}>
                {GLYPH_BADGES.clepsydra} {t('roadmap.queueAdd')}
              </button>
            ) : (
              <button className="btn" onClick={onUnqueue}>
                {t('roadmap.queueRemove')}
              </button>
            ))}
          {item.status === 'archived' ? (
            <button className="btn btn-restore" onClick={onRestore}>
              {t('roadmap.restore')}
            </button>
          ) : (
            <button className="btn danger" onClick={onArchive} disabled={stoppable}>
              {t('roadmap.archive')}
            </button>
          )}
        </div>
      </div>

      {depMenu && (
        <ContextMenu
          x={depMenu.x}
          y={depMenu.y}
          items={depCandidates.map((c) => ({
            label: c.title,
            onSelect: () => onAddDep(c.id)
          }))}
          onClose={() => setDepMenu(null)}
        />
      )}
    </div>
  )
}
