import { useEffect, useMemo } from 'react'
import type { RoadmapItem, RoadmapKind } from '@shared/types'
import { useT, type TFn } from '../i18n'
import { parseMarkdown, type BlockToken, type InlineToken } from '../markdown'

// Roadmap item detail modal (PLAN K5): the Trello-style foreground card opened
// by clicking a kanban card. Read view only -- editing stays in the form modal
// owned by RoadmapView. The markdown fields are agent-written, so rendering
// goes through the token tree of markdown.ts (React escapes every text node).

export const KIND_ICONS: Record<RoadmapKind, string> = {
  feature: '✨',
  bug: '🐞',
  debt: '🧱',
  idea: '💡',
  chore: '🧹'
}

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

function badges(item: RoadmapItem, t: TFn): React.JSX.Element {
  return (
    <div className="rm-detail-badges">
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
        <span className="rm-badge rm-badge-queue">⏳ #{item.queue}</span>
      )}
      {item.locked && (
        <span className="rm-badge rm-badge-locked" title={t('roadmap.lockedHint')}>
          🔒 {item.locked_by}
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

export function RoadmapItemModal({
  item,
  onClose,
  onEdit,
  onLaunch,
  onStop,
  onQueue,
  onUnqueue,
  onArchive,
  onRestore
}: {
  item: RoadmapItem
  onClose: () => void
  onEdit: () => void
  onLaunch: () => void
  onStop: () => void
  onQueue: () => void
  onUnqueue: () => void
  onArchive: () => void
  onRestore: () => void
}): React.JSX.Element {
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stoppable = item.locked && item.status === 'in_progress'

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal rm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="rm-detail-head">
          <span className="rm-kind" title={t(`roadmap.kind.${item.kind}`)}>
            {KIND_ICONS[item.kind]}
          </span>
          <h3>{item.title}</h3>
          <button className="icon-btn" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </header>

        {badges(item, t)}
        {item.locked && item.locked_at && (
          <p className="rm-locked-note">
            {t('roadmap.lockedSince', { name: item.locked_by ?? '', date: item.locked_at })}
          </p>
        )}

        <div className="rm-modal-body">
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
          {item.depends_on.length > 0 && (
            <section className="rm-modal-section">
              <h4>{t('roadmap.dependsOn')}</h4>
              <div className="rm-detail-badges">
                {item.depends_on.map((d) => (
                  <span key={d} className="rm-badge">
                    {d.slice(0, 8)}
                  </span>
                ))}
              </div>
            </section>
          )}
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
            <button className="danger" onClick={onStop}>
              {t('roadmap.stop')}
            </button>
          )}
          {item.status !== 'archived' &&
            item.status !== 'done' &&
            (item.queue === null ? (
              <button onClick={onQueue}>{t('roadmap.queueAdd')}</button>
            ) : (
              <button onClick={onUnqueue}>{t('roadmap.queueRemove')}</button>
            ))}
          <button onClick={onEdit} disabled={stoppable} title={stoppable ? t('roadmap.lockedHint') : undefined}>
            {t('common.edit')}
          </button>
          {item.status === 'archived' ? (
            <button onClick={onRestore}>{t('roadmap.restore')}</button>
          ) : (
            <button className="danger" onClick={onArchive} disabled={stoppable}>
              {t('roadmap.archive')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
