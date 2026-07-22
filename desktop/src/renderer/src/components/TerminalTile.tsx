import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { SessionRuntime, SnippetSummary } from '@shared/types'
import { GLYPHS, GLYPH_ACTIONS } from './icons'
import { useDeck } from '../store'
import { formatClock, useT } from '../i18n'
import { registerTerminal, unregisterTerminal } from '../terminal-registry'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { SnippetsDialog } from './SnippetsDialog'

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#1f1f1f', cursor: '#1f1f1f', selectionBackground: '#add6ff' }
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** Copy the current selection to the clipboard and clear it. No-op if empty. */
function copySelection(term: Terminal): boolean {
  const sel = term.getSelection()
  if (!sel) return false
  void navigator.clipboard.writeText(sel)
  term.clearSelection()
  return true
}

/** Paste clipboard text through xterm (bracketed-paste aware -> onData -> PTY). */
async function pasteFromClipboard(term: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) term.paste(text)
  } catch {
    /* clipboard read denied / unavailable */
  }
}

export function TerminalTile({
  session,
  hidden
}: {
  session: SessionRuntime
  hidden: boolean
}): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const maximizedId = useDeck((s) => s.maximizedId)
  const selectedId = useDeck((s) => s.selectedId)
  const setMaximized = useDeck((s) => s.setMaximized)
  const setSelected = useDeck((s) => s.setSelected)
  const restartSession = useDeck((s) => s.restartSession)
  const removeSession = useDeck((s) => s.removeSession)
  const openBrowser = useDeck((s) => s.openBrowser)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Snippet menu (PLAN C22): saved prompts inserted into Claude's input field.
  const [snippetMenu, setSnippetMenu] = useState<{
    x: number
    y: number
    snippets: SnippetSummary[]
  } | null>(null)
  const [manageSnippets, setManageSnippets] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const id = session.id

  function doFit(): void {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host) return
    // Skip while collapsed/hidden -- fitting a 0-sized element corrupts dims.
    if (host.clientWidth < 4 || host.clientHeight < 4) return
    try {
      fit.fit()
      window.api.ptyResize(id, term.cols, term.rows)
    } catch {
      /* terminal mid-teardown */
    }
  }

  // Create the xterm instance once per session id.
  useEffect(() => {
    const term = new Terminal({
      fontSize: config.fontSize,
      fontFamily: FONT_STACK,
      cursorBlink: true,
      scrollback: 8000,
      theme: THEMES[config.theme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
    if (hostRef.current) term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit
    registerTerminal(id, term)

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // Ctrl/Shift+Enter inserts a newline in Claude's prompt instead of
      // submitting. ESC+CR is the exact sequence Claude Code's /terminal-setup
      // binds Shift+Enter to (verified in the claude binary). Plain Enter still
      // submits (falls through to xterm's default \r).
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey) && !e.altKey && !e.metaKey) {
        window.api.ptyInput(id, '\x1b\r')
        return false
      }

      // Ctrl+Shift+F belongs to the cross-session search bar: keep it away from
      // xterm/the PTY and let the event bubble to App's window-level toggle.
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'f') {
        return false
      }

      // Ctrl+C copies when text is selected (then clears it); with no selection
      // it falls through so the PTY still receives the interrupt. Paste is left
      // to xterm's native paste handler -- intercepting it here would fire on top
      // of the native textarea paste event and paste twice.
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'c') {
        if (copySelection(term)) return false
        return !e.shiftKey // plain Ctrl+C interrupts; Ctrl+Shift+C is swallowed
      }

      return true
    })

    const onInput = term.onData((d) => window.api.ptyInput(id, d))
    const offData = window.api.onPtyData((e) => {
      if (e.id === id) term.write(e.data)
    })
    const offExit = window.api.onPtyExit((e) => {
      if (e.id === id) term.write('\r\n\x1b[2m[peer process exited]\x1b[0m\r\n')
    })

    const raf = requestAnimationFrame(doFit)
    return () => {
      cancelAnimationFrame(raf)
      onInput.dispose()
      offData()
      offExit()
      unregisterTerminal(id, term)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Re-apply theme / font size live.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = THEMES[config.theme]
    term.options.fontSize = config.fontSize
    requestAnimationFrame(doFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.theme, config.fontSize])

  // Refit on any container size change (maximize/restore, window resize, columns).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => doFit())
    ro.observe(host)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When a tile becomes visible again, it needs a fresh fit.
  useEffect(() => {
    if (!hidden) requestAnimationFrame(doFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden])

  const isMax = maximizedId === id
  const selected = selectedId === id

  // Open the saved-prompts menu anchored under the ⚡ button.
  const openSnippetMenu = async (anchor: HTMLElement): Promise<void> => {
    const rect = anchor.getBoundingClientRect()
    const snippets = await window.api.listSnippets()
    setSnippetMenu({ x: rect.left, y: rect.bottom + 4, snippets })
  }

  // Fill-not-send: paste goes through xterm's bracketed-paste path (onData ->
  // PTY), which fills Claude Code's input field WITHOUT submitting it -- the
  // operator can adjust the text, then press Enter.
  const insertSnippet = (text: string): void => {
    const term = termRef.current
    if (!term) return
    term.paste(text)
    term.focus()
  }

  const snippetMenuItems = (snippets: SnippetSummary[]): ContextMenuItem[] => [
    ...(snippets.length === 0
      ? [{ label: t('snippets.empty'), onSelect: () => undefined, disabled: true }]
      : snippets.map((s) => ({
          label: `${s.source === 'local' ? '📁 ' : ''}${s.name}`,
          onSelect: () => insertSnippet(s.text)
        }))),
    { label: t('snippets.manage'), onSelect: () => setManageSnippets(true) }
  ]

  return (
    <div
      className={[
        'tile',
        hidden ? 'tile-hidden' : '',
        selected ? 'tile-selected' : '',
        isMax ? 'tile-max' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--tile-color': session.color || 'transparent' } as React.CSSProperties}
      data-session-id={id}
      onMouseDown={() => setSelected(id)}
    >
      <div
        className="tile-head"
        onDoubleClick={(e) => {
          // Ignore double-clicks that land on a button (they have their own handler).
          if ((e.target as HTMLElement).closest('button')) return
          setMaximized(isMax ? null : id)
        }}
        title={t('tile.fullscreenTitle')}
      >
        <span
          className={`dot dot-${session.status}${session.needsAttention ? ' dot-attention' : session.rateLimited ? ' dot-limited' : session.thinking ? ' dot-thinking' : ''}`}
          title={
            session.needsAttention
              ? t('status.needsAttention')
              : session.rateLimited
                ? t('status.rateLimited')
                : session.thinking
                  ? t('status.thinking')
                  : t(`status.${session.status}`)
          }
        />
        <span className="tile-title" style={{ color: session.color || undefined }}>
          {session.name}
        </span>
        {session.peerId ? (
          <span className="tile-peer">{session.peerId}</span>
        ) : (
          <span className="tile-peer tile-peer-pending">
            {t('session.pending', { id: (session.sessionId || session.id).slice(0, 8) })}
          </span>
        )}
        {session.needsAttention && (
          <span className="tile-quota tile-attention">⏸ {t('attention.badge')}</span>
        )}
        {session.rateLimited && (
          <span className="tile-quota">
            {(session.autoResume ?? config.autoResumeQuota) && session.resumeAt
              ? t('quota.resumeAt', { time: formatClock(session.resumeAt) })
              : t('quota.limited')}
          </span>
        )}
        <span className="tile-spacer" />
        {session.status === 'exited' && (
          <button
            type="button"
            className="tile-btn"
            title={t('tile.restartTitle')}
            onClick={(e) => {
              e.stopPropagation()
              void restartSession(id)
            }}
          >
            ↻
          </button>
        )}
        <button
          type="button"
          className="tile-btn"
          title={t('tile.snippetsTitle')}
          onClick={(e) => {
            e.stopPropagation()
            void openSnippetMenu(e.currentTarget)
          }}
        >
          {GLYPH_ACTIONS.snippets}
        </button>
        <button
          type="button"
          className="tile-btn"
          title={t('tile.browserTitle')}
          onClick={(e) => {
            e.stopPropagation()
            openBrowser(id)
          }}
        >
          {GLYPHS.browser}
        </button>
        <button
          type="button"
          className="tile-btn"
          title={isMax ? t('common.restore') : t('common.maximize')}
          onClick={(e) => {
            e.stopPropagation()
            setMaximized(isMax ? null : id)
          }}
        >
          {isMax ? GLYPH_ACTIONS.restore : GLYPH_ACTIONS.expand}
        </button>
        <button
          type="button"
          className="tile-btn tile-btn-danger"
          title={t('tile.closeTitle')}
          onClick={(e) => {
            e.stopPropagation()
            setConfirmingDelete(true)
          }}
        >
          {GLYPH_ACTIONS.close}
        </button>
      </div>
      <div
        className="tile-body"
        ref={hostRef}
        onContextMenu={(e) => {
          // Right-click: copy the selection if any, otherwise paste.
          e.preventDefault()
          const term = termRef.current
          if (!term) return
          if (!copySelection(term)) void pasteFromClipboard(term)
        }}
      />
      {session.expired && (
        <div className="tile-expired">
          <div className="tile-expired-card">
            <strong>{t('tile.expiredTitle')}</strong>
            <p>{t('tile.expiredBody')}</p>
            <button
              className="primary"
              onClick={(e) => {
                e.stopPropagation()
                void restartSession(id)
              }}
            >
              {t('tile.startNew')}
            </button>
          </div>
        </div>
      )}
      {snippetMenu && (
        <ContextMenu
          x={snippetMenu.x}
          y={snippetMenu.y}
          items={snippetMenuItems(snippetMenu.snippets)}
          onClose={() => setSnippetMenu(null)}
        />
      )}
      {manageSnippets && <SnippetsDialog onClose={() => setManageSnippets(false)} />}
      {confirmingDelete && (
        <ConfirmDialog
          title={t('confirm.closeTitle')}
          message={t('confirm.closeMessage', { name: session.name })}
          confirmLabel={t('common.close')}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            void removeSession(id)
          }}
        />
      )}
    </div>
  )
}
