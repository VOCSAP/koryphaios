import { useEffect, useRef, useState } from 'react'
import type { TemplateSummary } from '@shared/types'
import { GLYPH_ACTIONS } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { TemplateComposer } from './TemplateComposer'

/**
 * Template picker. Lists global + local templates; the selected one can be
 * Used (append to the current sessions) or Applied (replace, confirmed first
 * when sessions are open). Opened from File > Import template, File > New
 * template… (card 290a14e2, straight to a blank composer), the home
 * "Use template" button, and (once already open) its own "Manage templates"
 * button.
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
  const composerSeed = useDeck((s) => s.templatesComposerSeed)
  const applyTemplate = useDeck((s) => s.applyTemplate)
  const removeTemplate = useDeck((s) => s.removeTemplate)
  const openTemplates = useDeck((s) => s.openTemplates)
  const refreshTemplates = useDeck((s) => s.refreshTemplates)
  const showToast = useDeck((s) => s.showToast)
  const clearComposerSeed = useDeck((s) => s.clearTemplatesComposerSeed)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null)
  // Composer (PLAN C18): open state; path null = create fresh.
  const [composer, setComposer] = useState<{ path: string | null } | null>(null)
  // Render key for a BLANK composer (card 290a14e2 review round 2), bumped at
  // both places that open one: the composerSeed effect below and the
  // manage-mode "New" button. `setComposer({ path: null })` alone does not
  // remount <TemplateComposer> when one is already showing a blank draft --
  // same type, same shallow-equal-looking state, no `key` change, so React
  // reuses the instance, and TemplateComposer seeds its `useState` draft
  // fields only on mount (its reload effect is guarded by `if (!path)
  // return`). A second "New template…" while a draft is in progress left
  // that draft on screen instead of a blank form -- pre-existing on the
  // "New" button too, caught by the test-engineer's
  // desktop-templates-composer-draft-reset test against production code.
  // NOT the same mechanism as the `useRef` sentinel removed from the effect
  // below: that one compared a value across component REMOUNTS; this one is
  // a purely local render key, never compared to anything.
  const composerNonce = useRef(0)
  // File > New template… (card 290a14e2): `composerSeed` is SELF-CLEARING --
  // this effect resets it to 0 (both here and, since the review, at the
  // store's own close path) the instant it acts on it. A first cut compared
  // an ever-increasing counter against a `useRef` sentinel that only lived
  // for this component instance; that broke the case it was meant to
  // survive: closing the WHOLE dialog and reopening it later via an
  // unrelated path (e.g. the home "Use template" button, no `composer` opt)
  // remounts this component, which re-initialises the ref, so a STALE
  // non-zero seed left over from an earlier "New template…" session forced
  // the composer back open every time -- caught live via a CDP screenshot,
  // not by the type/unit tests, which cannot see a remount's fresh `useRef`.
  // With self-clearing, a plain boolean would behave the same across two
  // SEPARATE trigger events (true -> false -> true is a real change either
  // way): the counter now earns its keep only for two requests landing in
  // the same React batch, where a boolean set to `true` twice collapses to
  // one edge. It is the self-clearing, not the counter, that closes the
  // remount-staleness bug above.
  useEffect(() => {
    if (composerSeed > 0) {
      composerNonce.current++
      setComposer({ path: null })
      clearComposerSeed()
    }
  }, [composerSeed, clearComposerSeed])

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
          {manage ? (
            <button
              onClick={() => {
                composerNonce.current++
                setComposer({ path: null })
              }}
            >
              {t('composer.new')}
            </button>
          ) : (
            <button onClick={() => openTemplates(true, { manage: true })}>{t('template.manage')}</button>
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
          key={composer.path ?? 'new-' + composerNonce.current}
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
