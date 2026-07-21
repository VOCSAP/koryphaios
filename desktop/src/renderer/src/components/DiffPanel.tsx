import { useEffect, useState } from 'react'
import type { DiffFile, SessionDiff } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'

// Diff / review panel (PLAN C13): what a session or worktree changed.
// Opened from the Worktrees view and the session right-click menu. Read-only;
// the "review" button spawns a one-shot agent that reports to the team-lead.

/** Path + untracked badge / +add −del counts of one file row. Shared with the
 * Git rail view (PLAN GX3) so the two never drift. */
export function DiffFileRow({ file }: { file: DiffFile }): React.JSX.Element {
  const t = useT()
  return (
    <>
      <span className="diff-file-path" title={file.path}>
        {file.path}
      </span>
      {file.untracked ? (
        <span className="diff-file-new">{t('diff.untracked')}</span>
      ) : (
        <span className="diff-file-counts">
          {file.additions !== null ? <span className="diff-add">+{file.additions}</span> : '·'}{' '}
          {file.deletions !== null ? <span className="diff-del">−{file.deletions}</span> : ''}
        </span>
      )}
    </>
  )
}

function FileList({ title, files }: { title: string; files: DiffFile[] }): React.JSX.Element {
  const t = useT()
  return (
    <div className="diff-files">
      <div className="diff-files-title">{title}</div>
      {files.length === 0 && <div className="diff-files-empty">{t('diff.noChanges')}</div>}
      {files.map((f) => (
        <div key={f.path} className="diff-file">
          <DiffFileRow file={f} />
        </div>
      ))}
    </div>
  )
}

/** Minimal unified-diff colorizer: one <div> per line, classed by prefix.
 * Shared with the Git rail view (PLAN GX3). */
export function DiffText({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="diff-text">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---')
          ? 'diff-line-file'
          : line.startsWith('@@')
            ? 'diff-line-hunk'
            : line.startsWith('+')
              ? 'diff-line-add'
              : line.startsWith('-')
                ? 'diff-line-del'
                : line.startsWith('# ---')
                  ? 'diff-line-section'
                  : ''
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export function DiffPanel(): React.JSX.Element | null {
  const t = useT()
  const target = useDeck((s) => s.diffTarget)
  const openDiff = useDeck((s) => s.openDiff)
  const showToast = useDeck((s) => s.showToast)
  const setView = useDeck((s) => s.setView)

  const [diff, setDiff] = useState<SessionDiff | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDiff(null)
    setError(null)
    if (!target) return
    window.api.collectDiff(target.dir).then(
      (d) => setDiff(d),
      (e) => setError(e instanceof Error ? e.message : String(e))
    )
  }, [target])

  if (!target) return null

  const review = async (): Promise<void> => {
    try {
      await window.api.reviewDiff(target.dir)
      openDiff(null)
      showToast('toast.reviewStarted')
      setView('agents')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const empty =
    diff && diff.uncommitted.length === 0 && (diff.branch === null || diff.branch.length === 0)

  return (
    <div className="modal-backdrop" onMouseDown={() => openDiff(null)}>
      <div className="modal diff-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <span className="diff-title" title={target.dir}>
            {t('diff.title', { name: target.title })}
          </span>
          <button className="inbox-close" title={t('inbox.close')} onClick={() => openDiff(null)}>
            ✕
          </button>
        </div>
        <div className="diff-body">
          {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}
          {!diff && !error && <div className="diff-files-empty">…</div>}
          {diff && (
            <>
              {diff.branch !== null && (
                <FileList
                  title={t('diff.branchSection', { base: diff.base ?? '?' })}
                  files={diff.branch}
                />
              )}
              <FileList title={t('diff.uncommittedSection')} files={diff.uncommitted} />
              {empty && <div className="diff-files-empty">{t('diff.allClean')}</div>}
              {diff.truncated && <div className="diff-truncated">{t('diff.truncated')}</div>}
              {diff.text.trim() !== '' && <DiffText text={diff.text} />}
            </>
          )}
        </div>
        <div className="modal-actions">
          <button onClick={() => openDiff(null)}>{t('common.close')}</button>
          <button className="primary" disabled={!diff || !!empty} onClick={() => void review()}>
            {t('diff.review')}
          </button>
        </div>
      </div>
    </div>
  )
}
