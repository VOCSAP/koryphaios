import { useCallback, useEffect, useState } from 'react'
import type { SnippetSummary } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

// Snippet manager (PLAN C22): create / edit / delete the reusable prompts the
// tile ⚡ menu inserts. A snippet lives as one .md file, either global or
// project-local (project shadows global on a name collision). Renaming or
// changing the scope writes the new file then deletes the old one.

interface Editing {
  /** Path of the file being edited; null = creating a new snippet. */
  path: string | null
  name: string
  local: boolean
  text: string
}

export function SnippetsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const [snippets, setSnippets] = useState<SnippetSummary[]>([])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<SnippetSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnippets(await window.api.listSnippets())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (): Promise<void> => {
    if (!editing || !editing.name.trim() || !editing.text.trim()) return
    try {
      const path = await window.api.saveSnippet(editing.name, editing.local, editing.text)
      // Rename / scope change: the content now lives at a new path -- drop the
      // old file so the snippet is moved, not duplicated.
      if (editing.path && editing.path !== path) await window.api.deleteSnippet(editing.path)
      setEditing(null)
      showToast('toast.snippetSaved')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('snippets.title')}</h2>
        <p className="snippets-hint">{t('snippets.hint')}</p>

        {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}

        {!editing && (
          <>
            {snippets.length === 0 ? (
              <p className="confirm-msg">{t('snippets.empty')}</p>
            ) : (
              <ul className="template-list">
                {snippets.map((s) => (
                  <li
                    key={s.path}
                    className="template-row"
                    onClick={() =>
                      setEditing({ path: s.path, name: s.name, local: s.source === 'local', text: s.text })
                    }
                    title={s.path}
                  >
                    <span className="template-name">{s.name}</span>
                    <span className={`template-source template-source-${s.source}`}>
                      {t(`template.source.${s.source}`)}
                    </span>
                    <span className="snippet-preview">{s.text.split('\n')[0]}</span>
                    <button
                      className="template-del"
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleting(s)
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                        <path
                          fill="currentColor"
                          d="M9 3v1H4v2h16V4h-5V3H9zM6 8l1 12h10l1-12H6zm3 2h2v8H9v-8zm4 0h2v8h-2v-8z"
                        />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button onClick={() => setEditing({ path: null, name: '', local: false, text: '' })}>
                {t('snippets.new')}
              </button>
              <button className="btn-cancel" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </>
        )}

        {editing && (
          <>
            <label className="field">
              <span>{t('snippets.name')}</span>
              <input
                value={editing.name}
                autoFocus
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('snippets.scope')}</span>
              <select
                value={editing.local ? 'local' : 'global'}
                onChange={(e) => setEditing({ ...editing, local: e.target.value === 'local' })}
              >
                <option value="global">{t('template.source.global')}</option>
                <option value="local">{t('template.source.local')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('snippets.text')}</span>
              <textarea
                rows={6}
                value={editing.text}
                placeholder={t('snippets.textPlaceholder')}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              <button
                className="primary"
                disabled={!editing.name.trim() || !editing.text.trim()}
                onClick={() => void save()}
              >
                {t('snippets.save')}
              </button>
            </div>
          </>
        )}
      </div>

      {deleting && (
        <ConfirmDialog
          title={t('snippets.confirmDeleteTitle')}
          message={t('snippets.confirmDeleteMessage', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const path = deleting.path
            setDeleting(null)
            void window.api.deleteSnippet(path).then(() => {
              showToast('toast.snippetDeleted', 'info')
              void refresh()
            })
          }}
        />
      )}
    </div>
  )
}
