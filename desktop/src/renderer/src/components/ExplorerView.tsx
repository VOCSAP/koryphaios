import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExplorerEntry, ExplorerFile, ExplorerRoot, HelpSelection } from '@shared/types'
import { selectionLineRange } from '@shared/code-selection'
import { useDeck } from '../store'
import { useT } from '../i18n'

// File explorer rail view (PLAN GX6): VS Code-style READ-ONLY browser over
// the roots the main process allows (project dir, worktrees, live session
// cwds — re-validated server-side on every call). Left: lazy tree; right:
// plain-text viewer with a line-number gutter (v1 has no syntax highlighting
// by operator decision — v2 notes shiki/highlight.js, see PLAN phase D).

/** Rendering cap: a huge file must not freeze the renderer. */
const MAX_RENDER_LINES = 5000
/** Cap on the code snippet carried into a roadmap draft (PLAN GX8). */
const TASK_SNIPPET_MAX = 4000

export function ExplorerView(): React.JSX.Element {
  const t = useT()
  const openHelpAssistant = useDeck((s) => s.openHelpAssistant)
  const openRoadmapDraft = useDeck((s) => s.openRoadmapDraft)
  // "Explain" routes through the help assistant; when the operator hid it
  // (config.helpButton === false) the seed would be silently consumed with no
  // popup, so the action is hidden too. "Create a task" stays available.
  const helpEnabled = useDeck((s) => s.config?.helpButton !== false)

  const [roots, setRoots] = useState<ExplorerRoot[]>([])
  const [root, setRoot] = useState<string | null>(null)
  /** Loaded listings per root-relative dir ('' = the root itself). */
  const [dirs, setDirs] = useState<Record<string, ExplorerEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [file, setFile] = useState<string | null>(null)
  const [fileData, setFileData] = useState<ExplorerFile | null>(null)
  /** Bumped by the Refresh button to force the open file to re-read. */
  const [reloadNonce, setReloadNonce] = useState(0)
  /** Active text selection inside the viewer (PLAN GX7), lines 1-based. */
  const [selection, setSelection] = useState<HelpSelection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const contentRef = useRef<HTMLPreElement>(null)

  const loadDir = useCallback(
    (r: string, rel: string): void => {
      window.api.explorerList(r, rel).then(
        (entries) => setDirs((d) => ({ ...d, [rel]: entries })),
        (e) => {
          const msg = e instanceof Error ? e.message : String(e)
          window.api.reportError('files', `explorerList failed: ${msg}`)
          setError(msg)
        }
      )
    },
    []
  )

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.explorerRoots()
      setRoots(next)
      setRoot((r) => (r && next.some((x) => x.path === r) ? r : (next[0]?.path ?? null)))
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      window.api.reportError('files', `explorerRoots failed: ${msg}`)
      setError(msg)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Root (re)selected: reset the tree and load its top level.
  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setFile(null)
    setFileData(null)
    if (root) loadDir(root, '')
  }, [root, loadDir])

  // File selected: load its content (and drop any previous selection).
  useEffect(() => {
    setSelection(null)
    if (!root || !file) {
      setFileData(null)
      return
    }
    let stale = false
    window.api.explorerRead(root, file).then(
      (f) => {
        if (!stale) setFileData(f)
      },
      (e) => {
        if (!stale) {
          const msg = e instanceof Error ? e.message : String(e)
          window.api.reportError('files', `explorerRead failed: ${msg}`)
          setError(msg)
        }
      }
    )
    return () => {
      stale = true
    }
  }, [root, file, reloadNonce])

  const toggleDir = (rel: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else {
        next.add(rel)
        if (root && dirs[rel] === undefined) loadDir(root, rel)
      }
      return next
    })
  }

  const renderEntries = (parentRel: string, depth: number): React.JSX.Element => {
    const entries = dirs[parentRel]
    const pad = { paddingLeft: `${8 + depth * 14}px` }
    if (!entries) {
      return (
        <div className="explorer-row explorer-row-note" style={pad}>
          …
        </div>
      )
    }
    if (entries.length === 0) {
      return (
        <div className="explorer-row explorer-row-note" style={pad}>
          {t('files.empty')}
        </div>
      )
    }
    return (
      <>
        {entries.map((e) => {
          const rel = parentRel ? `${parentRel}/${e.name}` : e.name
          if (e.dir) {
            const open = expanded.has(rel)
            return (
              <div key={rel}>
                <button className="explorer-row" style={pad} onClick={() => toggleDir(rel)}>
                  <span className="explorer-caret">{open ? '▾' : '▸'}</span>
                  <span className="explorer-name">{e.name}</span>
                </button>
                {open && renderEntries(rel, depth + 1)}
              </div>
            )
          }
          return (
            <button
              key={rel}
              className={`explorer-row${file === rel ? ' is-active' : ''}`}
              style={pad}
              title={rel}
              onClick={() => setFile(rel)}
            >
              <span className="explorer-caret" />
              <span className="explorer-name">{e.name}</span>
            </button>
          )
        })}
      </>
    )
  }

  // Selection capture (PLAN GX7): on mouseup inside the viewer, read the DOM
  // selection and derive the 1-based line range from the text offset before
  // the range start (the gutter is user-select:none, so only code is counted).
  const captureSelection = (): void => {
    const pre = contentRef.current
    const sel = window.getSelection()
    if (!pre || !file || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!pre.contains(range.startContainer) || !pre.contains(range.endContainer)) {
      setSelection(null)
      return
    }
    const text = sel.toString()
    if (!text.trim()) {
      setSelection(null)
      return
    }
    const before = document.createRange()
    before.selectNodeContents(pre)
    before.setEnd(range.startContainer, range.startOffset)
    const { startLine, endLine } = selectionLineRange(before.toString(), text)
    setSelection({ file, startLine, endLine, text })
  }

  const explainSelection = (): void => {
    if (!selection) return
    openHelpAssistant({
      question: t('files.explainQuestion', {
        file: selection.file,
        start: selection.startLine,
        end: selection.endLine
      }),
      selection
    })
  }

  const createTaskFromSelection = (): void => {
    if (!selection) return
    const name = selection.file.split('/').pop() ?? selection.file
    const snippet =
      selection.text.length > TASK_SNIPPET_MAX
        ? `${selection.text.slice(0, TASK_SNIPPET_MAX)}\n…`
        : selection.text
    openRoadmapDraft({
      title: t('files.taskTitle', { file: name }),
      kind: 'debt',
      description: [
        t('files.taskContext', {
          file: selection.file,
          start: selection.startLine,
          end: selection.endLine
        }),
        '',
        '```',
        snippet,
        '```'
      ].join('\n')
    })
  }

  const lines = fileData && !fileData.binary ? fileData.content.split('\n') : []
  const shown = lines.slice(0, MAX_RENDER_LINES)
  const clipped = !!fileData && (fileData.truncated || lines.length > MAX_RENDER_LINES)

  return (
    <div className="explorer-view">
      <header className="worktrees-head">
        <h2>{t('files.title')}</h2>
        <span className="git-readonly">{t('files.readOnly')}</span>
        <span className="roadmap-spacer" />
        {roots.length > 1 && (
          <select
            className="explorer-root-select"
            value={root ?? ''}
            onChange={(e) => setRoot(e.target.value)}
          >
            {roots.map((r) => (
              <option key={r.path} value={r.path} title={r.path}>
                {r.label}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn btn-sm"
          onClick={() => {
            // Reload the roots, every already-loaded directory (expanded nodes
            // included, so new files surface) and the open file.
            void refresh()
            if (root) for (const rel of Object.keys(dirs)) loadDir(root, rel)
            setReloadNonce((n) => n + 1)
          }}
        >
          {t('git.refresh')}
        </button>
      </header>

      {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}

      <div className="explorer-body">
        <aside className="explorer-tree">{root && renderEntries('', 0)}</aside>
        <section className="explorer-viewer">
          {!file && <div className="diff-files-empty explorer-hint">{t('files.select')}</div>}
          {file && (
            <>
              <div className="explorer-file-head">
                <span className="diff-file-path" title={file}>
                  {file}
                </span>
                {selection && (
                  <span className="explorer-sel-actions">
                    <span className="explorer-size">
                      {t('files.selLines', {
                        start: selection.startLine,
                        end: selection.endLine
                      })}
                    </span>
                    {helpEnabled && (
                      <button className="btn btn-sm" onClick={explainSelection}>
                        {t('files.explain')}
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={createTaskFromSelection}>
                      {t('files.createTask')}
                    </button>
                  </span>
                )}
                {fileData && <span className="explorer-size">{fileData.size} B</span>}
              </div>
              {fileData?.binary && (
                <div className="diff-files-empty">{t('files.binary', { size: fileData.size })}</div>
              )}
              {clipped && (
                <div className="diff-truncated">
                  {t('files.truncated', { size: fileData?.size ?? 0 })}
                </div>
              )}
              {fileData && !fileData.binary && (
                <div className="explorer-code" onMouseUp={captureSelection}>
                  <div className="explorer-gutter" aria-hidden="true">
                    {shown.map((_, i) => (
                      <div key={i}>{i + 1}</div>
                    ))}
                  </div>
                  <pre className="explorer-content" ref={contentRef}>
                    {shown.join('\n')}
                  </pre>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
