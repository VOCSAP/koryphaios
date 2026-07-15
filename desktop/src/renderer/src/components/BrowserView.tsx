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
//
// Two more vibeyard-inspired grounding tools (D1b):
//   - viewport presets: render the page at a device size; the active preset is
//     appended to every element/annotation prompt so the agent knows which
//     breakpoint the operator was looking at;
//   - draw mode: sketch over the page on a canvas overlay, then send — the
//     page screenshot is composited with the strokes, saved as a PNG under app
//     state, and the file path is pasted into the docked agent's prompt so a
//     multimodal agent can Read the annotated image.

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

/** Device-size presets (CSS px). Names are product names, not translated. */
interface ViewportPreset {
  id: string
  name: string
  w: number
  h: number
}

const VIEWPORTS: ViewportPreset[] = [
  { id: 'iphone-se', name: 'iPhone SE', w: 375, h: 667 },
  { id: 'iphone-15', name: 'iPhone 15 Pro', w: 393, h: 852 },
  { id: 'pixel-7', name: 'Pixel 7', w: 412, h: 915 },
  { id: 'ipad', name: 'iPad', w: 768, h: 1024 },
  { id: 'ipad-land', name: 'iPad landscape', w: 1024, h: 768 },
  { id: 'laptop', name: 'Laptop', w: 1280, h: 800 }
]

/** Stroke colour for draw mode: readable on both light and dark pages. */
const DRAW_STROKE = '#ff3b5c'

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
  const [viewport, setViewport] = useState<ViewportPreset | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [sendingDraw, setSendingDraw] = useState(false)
  const [dockWidth, setDockWidth] = useState(520)
  const [dragging, setDragging] = useState(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokingRef = useRef(false)
  const hasStrokesRef = useRef(false)

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
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  /** '[viewport: 375x667 – iPhone SE] ' when a device preset is active. */
  function viewportContext(): string {
    const vp = viewportRef.current
    return vp ? tRef.current('browser.viewportContext', { w: vp.w, h: vp.h, name: vp.name }) : ''
  }

  /** Paste into the docked running agent, else copy to the clipboard. */
  function deliverPrompt(prompt: string, sentKey: string, copiedKey: string): void {
    const target = pairedRef.current
    if (target && target.status === 'running') {
      window.api.ptyInput(target.id, bracketedPaste(prompt))
      showToast(sentKey)
    } else {
      void navigator.clipboard.writeText(prompt)
      showToast(copiedKey, 'info')
    }
  }

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
      prompt += viewportContext()
      deliverPrompt(prompt, 'toast.pickSent', 'toast.pickCopied')
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
    if (drawing) exitDraw()
    try {
      wv.send(picking ? 'deck:exit-inspect' : 'deck:enter-inspect')
      setPicking(!picking)
    } catch {
      /* webview not attached yet (page still loading) */
    }
  }

  // ----- draw mode (D1b) -----

  function exitDraw(): void {
    setDrawing(false)
    hasStrokesRef.current = false
  }

  function toggleDraw(): void {
    if (drawing) {
      exitDraw()
      return
    }
    if (picking) {
      try {
        webviewRef.current?.send('deck:exit-inspect')
      } catch {
        /* not attached */
      }
      setPicking(false)
    }
    setDrawing(true)
  }

  /** Size the canvas to its box; called on mount and box resize (clears strokes). */
  function fitCanvas(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w
      canvas.height = h
      hasStrokesRef.current = false
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!drawing || !canvas) return
    fitCanvas(canvas)
    const ro = new ResizeObserver(() => fitCanvas(canvas))
    ro.observe(canvas)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') exitDraw()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect()
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing])

  function strokePos(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onDrawDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    const ctx = e.currentTarget.getContext('2d')
    if (!ctx) return
    e.currentTarget.setPointerCapture(e.pointerId)
    strokingRef.current = true
    hasStrokesRef.current = true
    const { x, y } = strokePos(e)
    ctx.strokeStyle = DRAW_STROKE
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function onDrawMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!strokingRef.current) return
    const ctx = e.currentTarget.getContext('2d')
    if (!ctx) return
    const { x, y } = strokePos(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  function onDrawUp(): void {
    strokingRef.current = false
  }

  function clearDraw(): void {
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    hasStrokesRef.current = false
  }

  /** Capture the page, composite the strokes on top, save, prompt the agent. */
  async function sendAnnotation(): Promise<void> {
    const wv = webviewRef.current
    const canvas = canvasRef.current
    if (!wv || !canvas || sendingDraw) return
    setSendingDraw(true)
    try {
      const dataUrl = await window.api.captureBrowser(wv.getWebContentsId())
      if (!dataUrl) {
        showToast('toast.drawFailed', 'info')
        return
      }
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('decode'))
        img.src = dataUrl
      })
      // The capture is at device-pixel scale, the canvas at CSS px: composite
      // at capture size and scale the strokes up — same region, same ratio.
      const out = document.createElement('canvas')
      out.width = img.naturalWidth
      out.height = img.naturalHeight
      const ctx = out.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
      ctx.drawImage(canvas, 0, 0, out.width, out.height)
      const path = await window.api.saveAnnotation(out.toDataURL('image/png'))
      if (!path) {
        showToast('toast.drawFailed', 'info')
        return
      }
      const prompt =
        tRef.current('browser.drawPrompt', { url: wv.getURL(), path }) + viewportContext()
      deliverPrompt(prompt, 'toast.drawSent', 'toast.drawCopied')
      clearDraw()
      exitDraw()
    } catch {
      showToast('toast.drawFailed', 'info')
    } finally {
      setSendingDraw(false)
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
          <select
            className="browser-viewport-select"
            title={t('browser.viewport')}
            value={viewport?.id ?? ''}
            onChange={(e) => setViewport(VIEWPORTS.find((v) => v.id === e.target.value) ?? null)}
          >
            <option value="">{t('browser.viewportResponsive')}</option>
            {VIEWPORTS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.w}×{v.h})
              </option>
            ))}
          </select>
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
            className={`browser-btn${drawing ? ' browser-btn-active' : ''}`}
            title={t('browser.draw')}
            onClick={toggleDraw}
          >
            ✏
          </button>
          {drawing && (
            <>
              <button
                type="button"
                className="browser-btn browser-btn-accent"
                title={t('browser.drawSend')}
                disabled={sendingDraw}
                onClick={() => void sendAnnotation()}
              >
                📸
              </button>
              <button
                type="button"
                className="browser-btn"
                title={t('browser.drawClear')}
                onClick={clearDraw}
              >
                ⌫
              </button>
            </>
          )}
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
          <div
            className={`browser-frame${viewport ? ' browser-frame-device' : ''}`}
            style={viewport ? { width: viewport.w, height: viewport.h } : undefined}
          >
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
            {drawing && (
              <canvas
                ref={canvasRef}
                className="browser-draw-canvas"
                onPointerDown={onDrawDown}
                onPointerMove={onDrawMove}
                onPointerUp={onDrawUp}
                onPointerCancel={onDrawUp}
              />
            )}
          </div>
          {/* Webviews swallow mouse events; shield them while dragging the divider. */}
          {dragging && <div className="browser-drag-shield" />}
        </div>
      </div>
    </div>
  )
}
