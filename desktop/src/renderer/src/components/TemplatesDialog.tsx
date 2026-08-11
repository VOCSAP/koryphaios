import { useState } from 'react'
import type { TemplateSummary } from '@shared/types'
import { GLYPH_ACTIONS } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { TemplateComposer } from './TemplateComposer'

/**
 * Template picker. Lists global + local templates; the selected one can be
 * Used (append to the current sessions) or Applied (replace, confirmed first
 * when sessions are open). Opened from File > Import template and the home
 * "Use template" button.
 */
export function TemplatesDialog(): React.JSX.Element {
  const t = useT()
  const templates = useDeck((s) => s.templates)
  // Selector returns the store's array reference unfiltered (stable across
  // renders while the store is unchanged) -- filtering here would build a
  // new array every render and, on zustand v5's useSyncExternalStore,
  // fail the Object.is snapshot comparison every time, looping renders.
  // The supervisor is never an agent tile: HomeView.tsx renders it directly
  // (`sessions.find((s) => s.supervisor)`), and TileArea.tsx filters it out
  // of the grid the same way (`allSessions.filter((s) => !s.supervisor)`).
  // Apply/confirm must count agent sessions
  // only, or an empty window with just the supervisor open still shows Apply.
  const allSessions = useDeck((s) => s.sessions)
  const sessions = allSessions.filter((s) => !s.supervisor)
  const manage = useDeck((s) => s.templatesManage)
  const applyTemplate = useDeck((s) => s.applyTemplate)
  const removeTemplate = useDeck((s) => s.removeTemplate)
  const openTemplates = useDeck((s) => s.openTemplates)
  const refreshTemplates = useDeck((s) => s.refreshTemplates)
  const showToast = useDeck((s) => s.showToast)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null)
  // Composer (PLAN C18): open state; path null = create fresh.
  const [composer, setComposer] = useState<{ path: string | null } | null>(null)

  // Duplicate: read + rewrite under a copy name, next to the original.
  const duplicate = async (tpl: TemplateSummary): Promise<void> => {
    const content = await window.api.readTemplateFile(tpl.path)
    if (!content) return
    await window.api.writeTemplateFile(`${tpl.name}-copy`, tpl.source === 'local', {
      ...content,
      name: `${tpl.name}-copy`
    })
    showToast('toast.templateSaved')
    await refreshTemplates()
  }

  const use = (): void => {
    if (selected) void applyTemplate(selected, 'append')
  }
  const apply = (): void => {
    if (!selected) return
    // Replacing is destructive of the current layout -> confirm when non-empty.
    if (sessions.length > 0) setConfirmReplace(true)
    else void applyTemplate(selected, 'replace')
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openTemplates(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('template.pickTitle')}</h2>

        {templates.length === 0 ? (
          <p className="confirm-msg">{t('template.empty')}</p>
        ) : (
          <ul className="template-list">
            {templates.map((tpl) => (
              <li
                key={tpl.path}
                className={`template-row ${selected === tpl.path ? 'template-row-selected' : ''}`}
                onClick={() => setSelected(tpl.path)}
                title={tpl.path}
              >
                <span className="template-name">{tpl.name}</span>
                <span className={`template-source template-source-${tpl.source}`}>
                  {t(`template.source.${tpl.source}`)}
                </span>
                <span className="template-count">{t('template.sessions', { n: tpl.sessionCount })}</span>
                {/* Delete only in manage mode (File > Import template), never from
                    the home "Use template" path. */}
                {manage && (
                  <>
                    <button
                      className="row-btn template-row-btn"
                      title={t('composer.edit')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setComposer({ path: tpl.path })
                      }}
                    >
                      {GLYPH_ACTIONS.edit}
                    </button>
                    <button
                      className="row-btn template-row-btn"
                      title={t('composer.duplicate')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void duplicate(tpl)
                      }}
                    >
                      {GLYPH_ACTIONS.copy}
                    </button>
                    <button
                      className="template-del"
                      title={t('template.delete')}
                      aria-label={t('template.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleting(tpl)
                      }}
                    >
                      {GLYPH_ACTIONS.trash}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions template-actions">
          {manage && (
            <button onClick={() => setComposer({ path: null })}>{t('composer.new')}</button>
          )}
          <button className="btn-cancel" onClick={() => openTemplates(false)}>
            {t('common.cancel')}
          </button>
          {/* Replace only makes sense when there are sessions to replace; with an
              empty window (e.g. opened from the home "Use template" button) Apply
              would equal Use, so it is hidden. */}
          {sessions.length > 0 && (
            <button className="btn-apply" onClick={apply} disabled={!selected}>
              {t('template.apply')}
            </button>
          )}
          <button className="btn-use" onClick={use} disabled={!selected}>
            {t('template.use')}
          </button>
        </div>
      </div>

      {confirmReplace && selected && (
        <ConfirmDialog
          title={t('confirm.applyTemplateTitle')}
          message={t('confirm.applyTemplateMessage')}
          confirmLabel={t('template.apply')}
          onCancel={() => setConfirmReplace(false)}
          onConfirm={() => {
            setConfirmReplace(false)
            void applyTemplate(selected, 'replace')
          }}
        />
      )}

      {composer && (
        <TemplateComposer
          path={composer.path}
          onClose={() => setComposer(null)}
          onSaved={() => void refreshTemplates()}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t('confirm.deleteTemplateTitle')}
          message={t('confirm.deleteTemplateMessage', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const path = deleting.path
            setDeleting(null)
            if (selected === path) setSelected(null)
            void removeTemplate(path)
          }}
        />
      )}
    </div>
  )
}
