import { useEffect, useMemo, useState } from 'react'
import type { DiffFile, SessionDiff } from '@shared/types'
import { classifyDiffLines, type CodeLang, type DiffLineKind } from '@shared/code-lang'
import { GLYPH_ACTIONS } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { highlightBlocks, type HlBlock, type HlLine } from '../highlight'
import { CodeTokens } from './CodeTokens'

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

/** Structural class per line kind — the historical colours, unchanged. */
const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  file: 'diff-line-file',
  hunk: 'diff-line-hunk',
  section: 'diff-line-section',
  add: 'diff-line-add',
  del: 'diff-line-del',
  ctx: '',
  meta: ''
}

/** Unified-diff colorizer: one <div> per line, classed by kind, with the CODE
 * inside the line syntax-coloured through Shiki (card 526665f7). Shared with
 * the Git rail view (PLAN GX3).
 *
 * The two layers are deliberately independent: the diff structure stays a
 * background tint plus the +/- marker colour, and the syntax colours only
 * touch the code after the marker. A file whose language is unknown, or a
 * tokenisation that fails, keeps the structural rendering alone. */
export function DiffText({ text }: { text: string }): React.JSX.Element {
  const lines = useMemo(() => classifyDiffLines(text), [text])
  const [hl, setHl] = useState<Map<number, HlLine> | null>(null)

  useEffect(() => {
    setHl(null)
    // Tokenise per CONTIGUOUS run of code lines sharing one grammar, not per
    // line: a line tokenised alone loses every multi-line construct (block
    // comment, template literal), and one call per line would spend the whole
    // budget on a big diff. A run is cut by any structural line, so grammar
    // state never leaks across a hunk boundary.
    const blocks: HlBlock[] = []
    const rows: number[][] = []
    let cur: number[] = []
    let curLang: CodeLang | null = null
    const flush = (): void => {
      if (cur.length && curLang) {
        blocks.push({ code: cur.map((i) => lines[i]?.code ?? '').join('\n'), lang: curLang })
        rows.push(cur)
      }
      cur = []
      curLang = null
    }
    lines.forEach((line, i) => {
      if (line.code === null || line.lang === null) return flush()
      if (curLang && line.lang !== curLang) flush()
      curLang = line.lang
      cur.push(i)
    })
    flush()
    if (blocks.length === 0) return

    let stale = false
    void highlightBlocks(blocks)
      .then((results) => {
        if (stale) return
        const map = new Map<number, HlLine>()
        results.forEach((tokenLines, b) => {
          const block = rows[b]
          if (!tokenLines || !block || tokenLines.length !== block.length) return
          block.forEach((lineIndex, k) => {
            const tokens = tokenLines[k]
            if (tokens) map.set(lineIndex, tokens)
          })
        })
        if (map.size > 0) setHl(map)
      })
      .catch((e: unknown) => {
        // Structural diff colours survive; the failure still leaves a trace.
        window.api.reportError('diff', `syntax highlighting failed: ${String(e)}`)
      })
    return () => {
      stale = true
    }
  }, [lines])

  return (
    <pre className="diff-text shiki-code">
      {lines.map((line, i) => {
        const tokens = hl?.get(i)
        return (
          <div key={i} className={DIFF_LINE_CLASS[line.kind]}>
            {tokens && tokens.length > 0 ? (
              <>
                {line.text.slice(0, 1)}
                <CodeTokens line={tokens} />
              </>
            ) : (
              line.text || ' '
            )}
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
            {GLYPH_ACTIONS.close}
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
            {GLYPH_ACTIONS.search} {t('diff.review')}
          </button>
        </div>
      </div>
    </div>
  )
}
