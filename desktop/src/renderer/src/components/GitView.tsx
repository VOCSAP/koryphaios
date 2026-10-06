import { useCallback, useEffect, useState } from 'react'
import type { DiffFile, FileDiff, SessionDiff, WorktreeRow } from '@shared/types'
import { GLYPHS, GLYPH_ACTIONS } from './icons'
import { routeSandboxAuth, useDeck } from '../store'
import { useT } from '../i18n'
import { DiffFileRow, DiffText } from './DiffPanel'

// Git rail view (PLAN GX3): a permanent, READ-ONLY window on what the
// sessions changed — the SCM-style promotion of the C13 DiffPanel. Left: the
// project worktrees (plus live sessions running outside them). Right: numstat
// per file; clicking a file narrows the diff text to that file. By operator
// decision there is NO stage/commit/branch action here (and none delegated):
// the Deck observes, the agents commit.

const POLL_MS = 10_000

interface GitTarget {
  dir: string
  label: string
  isWorktree: boolean
  /** Uncommitted changes of this worktree — the very term the rail badge sums
   * (NavRail). `null` marks a target OUTSIDE that sum, so "counted and clean"
   * and "not counted at all" never render as the same thing. */
  dirty: number | null
  detached: boolean
  main: boolean
  sessionName: string | null
}

/** Last path segment: a detached worktree has no branch to name it, and the
 * 280px column would show an absolute path cut by its own ellipsis. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? path
}

function toTargets(worktrees: WorktreeRow[], sessions: { cwd: string; name: string; status: string; supervisor?: boolean }[]): GitTarget[] {
  const targets: GitTarget[] = worktrees.map((w) => ({
    dir: w.path,
    label: w.branch ?? baseName(w.path),
    isWorktree: true,
    dirty: w.dirty,
    detached: w.branch === null,
    main: w.main,
    sessionName: w.sessionName
  }))
  // Live sessions whose cwd is not a project worktree (custom dirs) — string
  // comparison only (the renderer cannot resolve paths); dupes just no-op.
  for (const s of sessions) {
    if (s.status === 'exited' || s.supervisor) continue
    if (!targets.some((t) => t.dir === s.cwd)) {
      targets.push({
        dir: s.cwd,
        label: s.cwd,
        isWorktree: false,
        dirty: null,
        detached: false,
        main: false,
        sessionName: s.name
      })
    }
  }
  return targets
}

export function GitView(): React.JSX.Element {
  const t = useT()
  const sessions = useDeck((s) => s.sessions)
  const showToast = useDeck((s) => s.showToast)
  const setView = useDeck((s) => s.setView)

  const [targets, setTargets] = useState<GitTarget[]>([])
  const [dir, setDir] = useState<string | null>(null)
  const [diff, setDiff] = useState<SessionDiff | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const worktrees = await window.api.listWorktrees()
      const next = toTargets(worktrees, sessions)
      setTargets(next)
      // Keep the selection when it survives the refresh; else pick main/first.
      setDir((d) => {
        if (d && next.some((x) => x.dir === d)) return d
        return next.find((x) => x.main)?.dir ?? next[0]?.dir ?? null
      })
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      window.api.reportError('git', `listWorktrees failed: ${msg}`)
      setError(msg)
    }
  }, [sessions])

  // Targets: initial load + poll while the view is mounted (refresh is
  // rebuilt when the session list changes, which also re-arms the poll).
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Diff of the selected target (re-collected on selection and each poll tick).
  useEffect(() => {
    if (!dir) {
      setDiff(null)
      return
    }
    let stale = false
    const collect = (): void => {
      window.api.collectDiff(dir).then(
        (d) => {
          if (!stale) {
            setDiff(d)
            setError(null)
          }
        },
        (e) => {
          if (!stale) {
            const msg = e instanceof Error ? e.message : String(e)
            window.api.reportError('git', `collectDiff failed: ${msg}`)
            setError(msg)
          }
        }
      )
    }
    collect()
    const timer = setInterval(collect, POLL_MS)
    return () => {
      stale = true
      clearInterval(timer)
    }
  }, [dir])

  // Per-file narrowing (PLAN GX2 channel): polled on the same cadence as the
  // full diff so a drilled-into file stays live while an agent edits it (the
  // numstat on the left already ticks — the text below must follow).
  useEffect(() => {
    if (!dir || !file) {
      setFileDiff(null)
      return
    }
    let stale = false
    const collect = (): void => {
      window.api.collectFileDiff(dir, file).then(
        (d) => {
          if (!stale) setFileDiff(d)
        },
        (e) => {
          if (!stale) {
            const msg = e instanceof Error ? e.message : String(e)
            window.api.reportError('git', `collectFileDiff failed: ${msg}`)
            setError(msg)
          }
        }
      )
    }
    collect()
    const timer = setInterval(collect, POLL_MS)
    return () => {
      stale = true
      clearInterval(timer)
    }
  }, [dir, file])

  // Selecting another target resets the file focus.
  const selectDir = (d: string): void => {
    setDir(d)
    setFile(null)
    setError(null)
  }

  const review = async (): Promise<void> => {
    if (!dir) return
    try {
      await window.api.reviewDiff(dir)
      showToast('toast.reviewStarted')
      setView('agents')
    } catch (e) {
      if (routeSandboxAuth(e)) return
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const empty =
    diff && diff.uncommitted.length === 0 && (diff.branch === null || diff.branch.length === 0)
  const shownText = file ? (fileDiff?.text ?? '') : (diff?.text ?? '')
  const shownTruncated = file ? !!fileDiff?.truncated : !!diff?.truncated

  const fileList = (title: string, files: DiffFile[]): React.JSX.Element => (
    <div className="diff-files">
      <div className="diff-files-title">{title}</div>
      {files.length === 0 && <div className="diff-files-empty">{t('diff.noChanges')}</div>}
      {files.map((f) => (
        <button
          key={f.path}
          className={`diff-file git-file${file === f.path ? ' is-active' : ''}`}
          title={f.path}
          onClick={() => setFile(file === f.path ? null : f.path)}
        >
          <DiffFileRow file={f} />
        </button>
      ))}
    </div>
  )

  const targetRow = (tg: GitTarget): React.JSX.Element => (
    <button
      key={tg.dir}
      className={`git-target${dir === tg.dir ? ' is-active' : ''}`}
      title={tg.dir}
      onClick={() => selectDir(tg.dir)}
    >
      <span className="git-target-head">
        <span className="git-target-label">
          {tg.isWorktree && <>{GLYPHS.git} </>}
          {tg.label}
        </span>
        {typeof tg.dirty === 'number' && Number.isInteger(tg.dirty) && (
          <span
            className={`rm-badge git-count${tg.dirty > 0 ? ' is-dirty' : ''}`}
            title={t('worktrees.dirty', { n: tg.dirty })}
          >
            {tg.dirty}
          </span>
        )}
      </span>
      {tg.main && <span className="rm-badge">{t('worktrees.main')}</span>}
      {tg.detached && <span className="rm-badge">{t('git.detached')}</span>}
      {tg.sessionName && (
        <span className="rm-badge rm-badge-status-in_progress">
          {t('worktrees.session', { name: tg.sessionName })}
        </span>
      )}
    </button>
  )

  const worktreeTargets = targets.filter((tg) => tg.isWorktree)
  const sessionTargets = targets.filter((tg) => !tg.isWorktree)

  return (
    <div className="git-view">
      <header className="worktrees-head">
        <h2>{t('git.title')}</h2>
        <span className="git-readonly">{t('git.readOnly')}</span>
        <span className="roadmap-spacer" />
        <button className="btn" onClick={() => void refresh()}>
          {t('git.refresh')}
        </button>
        <button className="primary" disabled={!diff || !!empty} onClick={() => void review()}>
          {GLYPH_ACTIONS.search} {t('diff.review')}
        </button>
      </header>

      {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}

      <div className="git-body">
        {/* Two GROUPS, each titled: the worktrees are exactly the terms the
            rail badge adds up, the live sessions running outside one are not.
            Without the titles a line without a counter would read "clean". */}
        <aside className="git-side">
          {worktreeTargets.length > 0 && (
            <div className="diff-files-title">{t('git.groupWorktrees')}</div>
          )}
          {worktreeTargets.map(targetRow)}
          {sessionTargets.length > 0 && (
            <div className="diff-files-title">{t('git.groupSessions')}</div>
          )}
          {sessionTargets.map(targetRow)}
          {targets.length === 0 && <div className="diff-files-empty">…</div>}
        </aside>

        <section className="git-detail">
          {!diff && !error && <div className="diff-files-empty">…</div>}
          {diff && (
            <>
              {diff.branch !== null &&
                fileList(t('diff.branchSection', { base: diff.base ?? '?' }), diff.branch)}
              {fileList(t('diff.uncommittedSection'), diff.uncommitted)}
              {empty && <div className="diff-files-empty">{t('diff.allClean')}</div>}
              {file && (
                <div className="git-file-head">
                  <span className="diff-file-path" title={file}>
                    {file}
                  </span>
                  <button className="icon-btn" title={t('git.fullDiff')} onClick={() => setFile(null)}>
                    {GLYPH_ACTIONS.close}
                  </button>
                </div>
              )}
              {shownTruncated && <div className="diff-truncated">{t('diff.truncated')}</div>}
              {shownText.trim() !== '' && <DiffText text={shownText} />}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
