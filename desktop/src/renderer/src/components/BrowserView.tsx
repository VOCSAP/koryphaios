// Embedded browser view (PLAN D1, experimental).
//
// Two ways in, one pane:
//   - the 🌐 rail entry: full-width browser for focused web-design work;
//   - the 🌐 button of an agent tile: the same browser with that agent's
//     terminal DOCKED on the left (second xterm on the same PTY — the tile in
//     the hidden Agents view stays mounted, so nothing is lost when leaving).
//
// The page lives in an Electron <webview> tag whose guest preload
// (preload/browser-inspect.ts) provides inspect mode: pick an element in the
// page and its description is injected into the docked agent's prompt as a
// bracketed paste (vibeyard's ESC[200~…ESC[201~ + PTY-write pattern), ready to
// be completed and submitted by the operator.

import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ElementPick, SessionRuntime } from '@shared/types'
import type { WebviewIpcMessageEvent, WebviewNavigateEvent, WebviewTag } from '../webview-types'
import { useDeck } from '../store'
import { useT } from '../i18n'

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#1f1f1f', cursor: '#1f1f1f', selectionBackground: '#add6ff' }
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** Wrap text in bracketed-paste marks: Claude Code's TUI treats it as a paste. */
function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

/** Prepend http:// when the input has no scheme (accepts bare localhost:3000). */
function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `http://${s}`
}

/** file: URL for the webview preload attribute (Windows backslashes included). */
function toFileUrl(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return `file://${norm.startsWith('/') ? '' : '/'}${norm}`
}

/**
 * Lightweight terminal bound to an existing session's PTY, for the browser
 * dock. Deliberately NOT TerminalTile: no registry registration (the hidden
 * Agents-view tile keeps owning cross-session search for this id), no
 * maximize/close chrome. A fresh xterm starts blank, so after the first fit we
 * shuffle the PTY size (rows-1 then back): the SIGWINCH pair makes Claude's
 * full-screen TUI repaint into the new instance.
 */
function DockTerminal({ session, active }: { session: SessionRuntime; active: boolean }): React.JSX.Element {
  const config = useDeck((s) => s.config!)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const id = session.id

  function doFit(): void {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host) return
    if (host.clientWidth < 4 || host.clientHeight < 4) return
    try {
      fit.fit()
      window.api.ptyResize(id, term.cols, term.rows)
    } catch {
      /* terminal mid-teardown */
    }
  }

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
    if (hostRef.current) term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit

    // Ctrl/Shift+Enter newline, same binding as TerminalTile.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey) && !e.altKey && !e.metaKey) {
        window.api.ptyInput(id, '\x1b\r')
        return false
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

    const raf = requestAnimationFrame(() => {
      doFit()
      // SIGWINCH shuffle (see component docstring). Skip degenerate sizes.
      const t = termRef.current
      if (t && t.rows > 2) {
        window.api.ptyResize(id, t.cols, t.rows - 1)
        setTimeout(() => {
          const t2 = termRef.current
          if (t2) window.api.ptyResize(id, t2.cols, t2.rows)
        }, 80)
      }
    })
    return () => {
      cancelAnimationFrame(raf)
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = THEMES[config.theme]
    term.options.fontSize = config.fontSize
    requestAnimationFrame(doFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.theme, config.fontSize])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => doFit())
    ro.observe(host)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) requestAnimationFrame(doFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return <div className="browser-dock-term" ref={hostRef} />
}

export function BrowserView({ active }: { active: boolean }): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const sessions = useDeck((s) => s.sessions)
  const pairedId = useDeck((s) => s.browserPairedId)
  const setBrowserPaired = useDeck((s) => s.setBrowserPaired)
  const setView = useDeck((s) => s.setView)
  const setSelected = useDeck((s) => s.setSelected)
  const showToast = useDeck((s) => s.showToast)

  const paired = sessions.find((s) => s.id === pairedId) ?? null
  const dockable = sessions.filter((s) => !s.supervisor)

  const webviewRef = useRef<WebviewTag | null>(null)
  const [preloadPath, setPreloadPath] = useState<string | null>(null)
  // Initial src captured once: later URL changes flow through loadURL/events,
  // never through the src attribute (resetting src reloads the page).
  const initialUrl = useRef(normalizeUrl(config.browserUrl) || 'http://localhost:3000')
  const [urlText, setUrlText] = useState(initialUrl.current)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [picking, setPicking] = useState(false)
  const [dockWidth, setDockWidth] = useState(520)
  const [dragging, setDragging] = useState(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The preload attribute must be set before src, so the webview renders only
  // once the path is known (vibeyard does the same dance).
  useEffect(() => {
    void window.api.getBrowserPreloadPath().then((p) => setPreloadPath(toFileUrl(p)))
  }, [])

  // Keep latest values available to the stable webview listeners.
  const pairedRef = useRef(paired)
  pairedRef.current = paired
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !preloadPath) return

    const syncNav = (): void => {
      try {
        setCanBack(wv.canGoBack())
        setCanFwd(wv.canGoForward())
      } catch {
        /* not attached yet */
      }
    }
    const onNavigate = (e: Event): void => {
      const ev = e as WebviewNavigateEvent
      if (ev.isMainFrame === false) return
      setUrlText(ev.url)
      syncNav()
      // Remember the last URL (debounced: HMR-heavy pages navigate often).
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => {
        void window.api.setConfig({ browserUrl: ev.url })
      }, 800)
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }
    const onIpc = (e: Event): void => {
      const ev = e as WebviewIpcMessageEvent
      if (ev.channel === 'deck:inspect-ended') {
        setPicking(false)
        return
      }
      if (ev.channel !== 'deck:element-selected') return
      const pick = ev.args[0] as ElementPick
      const tt = tRef.current
      const selector = pick.selectors[0]?.value ?? pick.tagName
      let prompt = tt('browser.elementPrompt', {
        tag: pick.tagName,
        url: pick.pageUrl,
        selector,
        w: pick.width,
        h: pick.height
      })
      if (pick.text) prompt += tt('browser.elementPromptText', { text: pick.text })
      const target = pairedRef.current
      if (target && target.status === 'running') {
        window.api.ptyInput(target.id, bracketedPaste(prompt))
        showToast('toast.pickSent')
      } else {
        void navigator.clipboard.writeText(prompt)
        showToast('toast.pickCopied', 'info')
      }
    }

    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('ipc-message', onIpc)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('ipc-message', onIpc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloadPath])

  function navigate(): void {
    const wv = webviewRef.current
    const url = normalizeUrl(urlText)
    if (!wv || !url) return
    setUrlText(url)
    void wv.loadURL(url).catch(() => {
      /* aborted / unreachable: the webview shows its own error page */
    })
  }

  function togglePick(): void {
    const wv = webviewRef.current
    if (!wv) return
    try {
      wv.send(picking ? 'deck:exit-inspect' : 'deck:enter-inspect')
      setPicking(!picking)
    } catch {
      /* webview not attached yet (page still loading) */
    }
  }

  function startDockDrag(e: React.MouseEvent): void {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX
    const startW = dockWidth
    const onMove = (ev: MouseEvent): void =>
      setDockWidth(Math.min(1000, Math.max(280, startW + (ev.clientX - startX))))
    const onUp = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="browser-view">
      {paired && (
        <>
          <div className="browser-dock" style={{ width: dockWidth }}>
            <div
              className="browser-dock-head"
              style={{ '--tile-color': paired.color || 'transparent' } as React.CSSProperties}
            >
              <span className={`dot dot-${paired.status}${paired.thinking ? ' dot-thinking' : ''}`} />
              <span className="tile-title" style={{ color: paired.color || undefined }}>
                {paired.name}
              </span>
              {paired.peerId && <span className="tile-peer">{paired.peerId}</span>}
              <span className="tile-spacer" />
              <button
                type="button"
                className="tile-btn"
                title={t('browser.backToAgents')}
                onClick={() => {
                  setSelected(paired.id)
                  setView('agents')
                }}
              >
                🖥
              </button>
              <button
                type="button"
                className="tile-btn"
                title={t('browser.dockDetach')}
                onClick={() => setBrowserPaired(null)}
              >
                ✕
              </button>
            </div>
            <DockTerminal session={paired} active={active} />
          </div>
          <div className="browser-divider" onMouseDown={startDockDrag} />
        </>
      )}
      <div className="browser-pane">
        <div className="browser-toolbar">
          <button
            type="button"
            className="browser-btn"
            title={t('browser.back')}
            disabled={!canBack}
            onClick={() => webviewRef.current?.goBack()}
          >
            ←
          </button>
          <button
            type="button"
            className="browser-btn"
            title={t('browser.forward')}
            disabled={!canFwd}
            onClick={() => webviewRef.current?.goForward()}
          >
            →
          </button>
          <button
            type="button"
            className={`browser-btn${loading ? ' browser-btn-loading' : ''}`}
            title={t('browser.reload')}
            onClick={(e) => {
              const wv = webviewRef.current
              if (!wv) return
              if (e.shiftKey) wv.reloadIgnoringCache()
              else wv.reload()
            }}
          >
            ⟳
          </button>
          <input
            className="browser-url"
            value={urlText}
            placeholder={t('browser.urlPlaceholder')}
            spellCheck={false}
            onChange={(e) => setUrlText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate()
            }}
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className={`browser-btn${picking ? ' browser-btn-active' : ''}`}
            title={t('browser.pick')}
            onClick={togglePick}
          >
            ⌖
          </button>
          <button
            type="button"
            className="browser-btn"
            title={t('browser.devtools')}
            onClick={() => webviewRef.current?.openDevTools()}
          >
            🔧
          </button>
          <button
            type="button"
            className="browser-btn"
            title={t('browser.external')}
            onClick={() => {
              const url = webviewRef.current?.getURL()
              if (url) window.open(url)
            }}
          >
            ↗
          </button>
          <select
            className="browser-dock-select"
            title={t('browser.dockLabel')}
            value={pairedId ?? ''}
            onChange={(e) => setBrowserPaired(e.target.value || null)}
          >
            <option value="">{t('browser.noDock')}</option>
            {dockable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.peerId ? ` — ${s.peerId}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="browser-body">
          {preloadPath && (
            <webview
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ref={(el: any) => {
                webviewRef.current = el as WebviewTag | null
              }}
              className="browser-webview"
              src={initialUrl.current}
              preload={preloadPath}
              partition="persist:deck-browser"
              // The guest preload requires the real electron ipcRenderer.
              webpreferences="sandbox=no,backgroundThrottling=no"
            />
          )}
          {/* Webviews swallow mouse events; shield them while dragging the divider. */}
          {dragging && <div className="browser-drag-shield" />}
        </div>
      </div>
    </div>
  )
}
