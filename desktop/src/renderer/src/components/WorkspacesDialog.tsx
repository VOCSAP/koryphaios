import { useState } from 'react'
import type { WorkspaceSummary } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * Workspaces list ("List workspaces"). Save / Save As now live in the File menu;
 * this window lists the project's saved workspaces with a primary Restore and a
 * danger Delete. Restore routes through requestRestore (loss-warning when the
 * current window already has sessions); Delete is disabled for the current
 * workspace and confirmed otherwise.
 */
export function WorkspacesDialog(): React.JSX.Element {
  const t = useT()
  const workspaces = useDeck((s) => s.workspaces)
  const loadOnly = useDeck((s) => s.workspacesLoadOnly)
  const openWorkspaces = useDeck((s) => s.openWorkspaces)
  const requestRestore = useDeck((s) => s.requestRestore)
  const removeWorkspace = useDeck((s) => s.removeWorkspace)

  const [deleting, setDeleting] = useState<WorkspaceSummary | null>(null)

  // Compact local date + time, e.g. "2 Jun, 15:42", as a temporal cue.
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    })

  return (
    <div className="modal-backdrop" onMouseDown={() => openWorkspaces(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('workspaces.title')}</h2>

        <ul className="ws-list">
          {workspaces.map((ws) => (
            <li key={ws.id} className={`ws-row ${ws.current ? 'ws-row-current' : ''}`}>
              <div className="ws-main">
                <span className="ws-name">{ws.name}</span>
                <span className="ws-sub">
                  {ws.scopeName} · {t('workspaces.sessions', { n: ws.sessionCount })} · {fmt(ws.updatedAt)}
                </span>
              </div>
              <div className="ws-badges">
                {ws.current && (
                  <span className="ws-badge ws-badge-current">{t('workspaces.current')}</span>
                )}
                {ws.pinned && <span className="ws-badge">{t('workspaces.pinned')}</span>}
                {ws.locked && <span className="ws-badge ws-badge-locked">{t('workspaces.locked')}</span>}
              </div>
              <button
                className="ws-btn primary"
                disabled={ws.current || ws.locked || ws.sessionCount === 0}
                onClick={() => requestRestore(ws.id)}
              >
                {t('workspaces.restore')}
              </button>
              {!loadOnly && (
                <button
                  className="ws-btn ws-btn-danger"
                  disabled={ws.current || ws.locked}
                  onClick={() => setDeleting(ws)}
                >
                  {t('workspaces.delete')}
                </button>
              )}
            </li>
          ))}
          {workspaces.length === 0 && <li className="ws-empty">{t('workspaces.empty')}</li>}
        </ul>

        <div className="modal-actions">
          <button onClick={() => openWorkspaces(false)}>{t('common.close')}</button>
        </div>
      </div>

      {deleting && (
        <ConfirmDialog
          title={t('confirm.deleteWorkspaceTitle')}
          message={t('confirm.deleteWorkspaceMessage', { name: deleting.name })}
          confirmLabel={t('workspaces.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id
            setDeleting(null)
            void removeWorkspace(id)
          }}
        />
      )}
    </div>
  )
}
