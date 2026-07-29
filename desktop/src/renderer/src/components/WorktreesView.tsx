import { useCallback, useEffect, useState } from 'react'
import type { WorktreeRow } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { GLYPHS } from './icons'

// Worktrees view (PLAN C6): see and manage the worktrees the agents use.
// Orphans (no live session) are the main target -- resume them with a new
// session or clean them up after a merge. Removal is never forced and never
// deletes the branch (worktree-service rules).

const POLL_MS = 10_000

export function WorktreesView(): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const createSession = useDeck((s) => s.createSession)
  const setView = useDeck((s) => s.setView)
  const openDiff = useDeck((s) => s.openDiff)

  const [rows, setRows] = useState<WorktreeRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchDraft, setBranchDraft] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<WorktreeRow | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRows(await window.api.listWorktrees())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const create = async (): Promise<void> => {
    const branch = branchDraft.trim()
    if (!branch) return
    try {
      await window.api.createWorktree(branch)
      setBranchDraft('')
      showToast('toast.worktreeCreated')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openSession = async (w: WorktreeRow): Promise<void> => {
    // Adopt the existing worktree: the session gets the branch badge and the
    // "also remove the worktree?" close flow, like a Deck-created one.
    await createSession({
      cwd: w.path,
      worktree: { path: w.path, branch: w.branch ?? '?' }
    })
    setView('agents')
  }

  const remove = async (w: WorktreeRow): Promise<void> => {
    try {
      await window.api.removeWorktree(w.path)
      showToast('toast.worktreeRemoved')
    } catch {
      // Dirty/locked tree: git refused (never forced) -- uncommitted work is safe.
      showToast('toast.worktreeRemoveFailed', 'info')
    }
    await refresh()
  }

  const copyPath = (w: WorktreeRow): void => {
    void navigator.clipboard.writeText(w.path)
    showToast('toast.pathCopied')
  }

  return (
    <div className="worktrees-view">
      <header className="worktrees-head">
        <h2>{t('worktrees.title')}</h2>
        <span className="roadmap-spacer" />
        <input
          className="worktrees-branch-input"
          value={branchDraft}
          placeholder={t('worktrees.branchPlaceholder')}
          onChange={(e) => setBranchDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
        />
        <button className="primary" disabled={!branchDraft.trim()} onClick={() => void create()}>
          {t('worktrees.create')}
        </button>
      </header>

      {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}

      <div className="worktrees-list">
        {loaded && rows.length === 0 && !error && (
          <p className="roadmap-empty">{t('worktrees.empty')}</p>
        )}
        {rows.map((w) => {
          const orphan = !w.main && !w.sessionId
          return (
            <div key={w.path} className={`wt-row${orphan ? ' wt-row-orphan' : ''}`}>
              <div className="wt-main">
                <span className="wt-branch">
                  {GLYPHS.git} {w.branch ?? '(detached)'}
                </span>
                {w.main && <span className="rm-badge">{t('worktrees.main')}</span>}
                {w.sessionName ? (
                  <span className="rm-badge rm-badge-status-in_progress">
                    {t('worktrees.session', { name: w.sessionName })}
                  </span>
                ) : (
                  !w.main && (
                    <span className="rm-badge wt-badge-orphan">{t('worktrees.orphan')}</span>
                  )
                )}
                {w.dirty > 0 ? (
                  <span className="rm-badge rm-badge-effort-high">
                    {t('worktrees.dirty', { n: w.dirty })}
                  </span>
                ) : (
                  <span className="rm-badge rm-badge-value-high">{t('worktrees.clean')}</span>
                )}
              </div>
              <div className="wt-sub" title={w.path}>
                {w.path}
                {w.lastCommit ? ` — ${w.lastCommit}` : ''}
              </div>
              <div className="wt-actions">
                {!w.sessionId && !w.main && (
                  <button className="btn" onClick={() => void openSession(w)}>
                    {t('worktrees.openSession')}
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() => openDiff({ dir: w.path, title: w.branch ?? w.path })}
                >
                  {t('worktrees.diff')}
                </button>
                <button className="btn" onClick={() => copyPath(w)}>
                  {t('worktrees.copyPath')}
                </button>
                {!w.main && (
                  <button className="btn danger" onClick={() => setConfirmRemove(w)}>
                    {t('worktrees.remove')}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title={t('confirm.removeWorktreeTitle')}
          message={t('confirm.removeWorktreeMessage', {
            branch: confirmRemove.branch ?? '?',
            path: confirmRemove.path
          })}
          confirmLabel={t('confirm.removeWorktreeConfirm')}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const w = confirmRemove
            setConfirmRemove(null)
            void remove(w)
          }}
        />
      )}
    </div>
  )
}
