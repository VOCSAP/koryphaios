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
//
// D2a generalizes the pane beyond the web: a WINDOW mode mirrors any OS window
// (desktopCapturer still) and the same draw/send flow annotates it — design
// feedback on native apps (the Deck itself, a Tauri build…) with zero
// integration in the target. Element picking stays web-only; for native
// targets the sketch + multimodal Read covers the "which element" question.

import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ElementPick, SessionRuntime, WindowSource } from '@shared/types'
import {
  computeCropRect,
  formatElapsed,
  pickRecorderMime,
  type RecordingScope
} from '@shared/recording'
import type { WebviewIpcMessageEvent, WebviewNavigateEvent, WebviewTag } from '../webview-types'
import { GLYPHS, GLYPH_ACTIONS } from './icons'
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
  /** Last page-level failure (did-fail-load / renderer gone), or null (O6). */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [viewport, setViewport] = useState<ViewportPreset | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [sendingDraw, setSendingDraw] = useState(false)
  // Window-mirror mode (D2a). The webview stays mounted (hidden) meanwhile.
  const [mode, setMode] = useState<'web' | 'window'>('web')
  const [windows, setWindows] = useState<WindowSource[]>([])
  const [windowId, setWindowId] = useState('')
  const [shot, setShot] = useState<{ dataUrl: string; title: string } | null>(null)
  const [shotLoading, setShotLoading] = useState(false)
  const [dockWidth, setDockWidth] = useState(520)
  const [dragging, setDragging] = useState(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokingRef = useRef(false)
  const hasStrokesRef = useRef(false)
  // Screen recording (REC). recordingSince lives in the store so the nav rail
  // can show the indicator from any view (this component stays mounted).
  const recordingSince = useDeck((s) => s.recordingSince)
  const setRecordingSince = useDeck((s) => s.setRecordingSince)
  const [recDialog, setRecDialog] = useState(false)
  const [recScope, setRecScope] = useState<RecordingScope>('browser')
  const [recElapsed, setRecElapsed] = useState(0)
  const [recSaving, setRecSaving] = useState(false)
  const recRef = useRef<{
    rec: MediaRecorder
    source: MediaStream
    stopCrop: (() => void) | null
    chunks: Blob[]
    ext: 'mp4' | 'webm'
    mime: string
  } | null>(null)
  const browserFrameRef = useRef<HTMLDivElement | null>(null)

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

    // Page failure surfaces (O6): before these, a dead page was just a blank
    // frame. -3 (ERR_ABORTED) is user navigation noise, not a failure.
    const onFailLoad = (e: Event): void => {
      const ev = e as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
      if (!ev.isMainFrame || ev.errorCode === -3) return
      setLoadError(`${ev.errorDescription || ev.errorCode} — ${ev.validatedURL}`)
    }
    const onGone = (e: Event): void => {
      const ev = e as Event & { details?: { reason?: string } }
      const reason = ev.details?.reason ?? 'unknown'
      if (reason === 'clean-exit') return
      window.api.reportError('browser', `webview render process gone (${reason})`)
      setLoadError(`renderer gone: ${reason}`)
    }
    const clearError = (): void => setLoadError(null)

    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-start-loading', clearError)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFailLoad)
    wv.addEventListener('render-process-gone', onGone)
    wv.addEventListener('ipc-message', onIpc)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-start-loading', clearError)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFailLoad)
      wv.removeEventListener('render-process-gone', onGone)
      wv.removeEventListener('ipc-message', onIpc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloadPath])

  function navigate(): void {
    const wv = webviewRef.current
    const url = normalizeUrl(urlText)
    if (!wv || !url) return
    setUrlText(url)
    void wv.loadURL(url).catch((e) => {
      // did-fail-load paints the in-view error; keep a log trace as well (O6).
      window.api.reportError('browser', `loadURL(${url}) rejected: ${String(e)}`)
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

  // ----- window mirror (D2a) -----

  function disarmModes(): void {
    if (picking) {
      try {
        webviewRef.current?.send('deck:exit-inspect')
      } catch {
        /* not attached */
      }
      setPicking(false)
    }
    if (drawing) exitDraw()
  }

  async function captureShot(id: string): Promise<void> {
    setShotLoading(true)
    try {
      const next = await window.api.captureWindow(id)
      if (next) setShot(next)
      else showToast('toast.drawFailed', 'info')
    } finally {
      setShotLoading(false)
    }
  }

  async function refreshWindows(): Promise<void> {
    const list = await window.api.listCaptureWindows()
    setWindows(list)
    // A remembered selection that vanished (window closed) resets the picker.
    if (windowId && !list.some((w) => w.id === windowId)) {
      setWindowId('')
      setShot(null)
    }
  }

  function switchMode(next: 'web' | 'window'): void {
    if (next === mode) return
    disarmModes()
    setMode(next)
    if (next === 'window') void refreshWindows()
  }

  function selectWindow(id: string): void {
    disarmModes()
    setWindowId(id)
    setShot(null)
    if (id) void captureShot(id)
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

  /**
   * Composite the strokes over the captured image, save, prompt the agent.
   * Web mode captures the live page; window mode reuses the DISPLAYED still
   * (the strokes were drawn on it — a fresh capture could have moved).
   */
  async function sendAnnotation(): Promise<void> {
    const wv = webviewRef.current
    const canvas = canvasRef.current
    if (!canvas || sendingDraw) return
    if (mode === 'web' && !wv) return
    if (mode === 'window' && !shot) return
    setSendingDraw(true)
    try {
      const dataUrl =
        mode === 'web' ? await window.api.captureBrowser(wv!.getWebContentsId()) : shot!.dataUrl
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
        mode === 'web'
          ? tRef.current('browser.drawPrompt', { url: wv!.getURL(), path }) + viewportContext()
          : tRef.current('browser.windowDrawPrompt', { title: shot!.title, path })
      deliverPrompt(prompt, 'toast.drawSent', 'toast.drawCopied')
      clearDraw()
      exitDraw()
    } catch {
      showToast('toast.drawFailed', 'info')
    } finally {
      setSendingDraw(false)
    }
  }

  // ----- screen recording (REC) -----
  //
  // getDisplayMedia is answered main-side with the Deck's own window (no OS
  // picker — see setDisplayMediaRequestHandler in main/index.ts). Scope
  // 'browser' pipes that stream through a canvas cropped to the browser frame
  // (computeCropRect); 'window' records the stream as-is. MediaRecorder
  // chunks accumulate in memory (demo-length clips) and are saved in one IPC
  // call when the operator stops.

  /** Ticking m:ss label while recording. */
  useEffect(() => {
    if (recordingSince === null) return
    setRecElapsed(Date.now() - recordingSince)
    const iv = setInterval(() => setRecElapsed(Date.now() - recordingSince), 500)
    return () => clearInterval(iv)
  }, [recordingSince])

  /** rAF pipeline drawing the browser-frame crop of `src` onto a canvas. */
  async function buildCropStream(
    src: MediaStream
  ): Promise<{ stream: MediaStream; stop: () => void } | null> {
    const frame = browserFrameRef.current
    if (!frame) return null
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = src
    try {
      await video.play()
    } catch {
      return null
    }
    const crop = computeCropRect(
      video.videoWidth,
      video.videoHeight,
      window.innerWidth,
      window.innerHeight,
      frame.getBoundingClientRect()
    )
    if (!crop) return null
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(crop.sw)
    canvas.height = Math.round(crop.sh)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    let raf = 0
    const draw = (): void => {
      // Recompute each frame: the pane can be resized mid-recording (the
      // output size stays fixed — the crop is scaled into the canvas).
      const r = computeCropRect(
        video.videoWidth,
        video.videoHeight,
        window.innerWidth,
        window.innerHeight,
        frame.getBoundingClientRect()
      )
      if (r) ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height)
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return {
      stream: canvas.captureStream(30),
      stop: () => {
        cancelAnimationFrame(raf)
        video.srcObject = null
      }
    }
  }

  async function startRecording(scope: RecordingScope): Promise<void> {
    if (recRef.current) return
    setRecDialog(false)
    const pick = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m))
    if (!pick) {
      window.api.reportError('browser', 'recording: no supported MediaRecorder container')
      showToast('toast.recordFailed', 'error')
      return
    }
    let source: MediaStream
    try {
      source = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: 30 }
      })
    } catch (e) {
      window.api.reportError('browser', `recording: getDisplayMedia failed: ${String(e)}`)
      showToast('toast.recordFailed', 'error')
      return
    }
    let outStream = source
    let stopCrop: (() => void) | null = null
    if (scope === 'browser') {
      const cropped = await buildCropStream(source)
      if (cropped) {
        outStream = cropped.stream
        stopCrop = cropped.stop
      } else {
        // Degenerate frame (hidden pane, zero-size crop): record the whole
        // window instead of failing, and say so.
        showToast('toast.recordFallbackWindow', 'info')
      }
    }
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(outStream, { mimeType: pick.mime, videoBitsPerSecond: 6_000_000 })
    } catch (e) {
      stopCrop?.()
      source.getTracks().forEach((t2) => t2.stop())
      window.api.reportError('browser', `recording: MediaRecorder failed: ${String(e)}`)
      showToast('toast.recordFailed', 'error')
      return
    }
    const entry = { rec, source, stopCrop, chunks: [] as Blob[], ext: pick.ext, mime: pick.mime }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) entry.chunks.push(e.data)
    }
    rec.onstop = () => void finishRecording()
    // The OS can end the capture from outside (source window closed).
    source.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording())
    recRef.current = entry
    rec.start(1000)
    setRecordingSince(Date.now())
  }

  /** Operator stop: triggers MediaRecorder.onstop → finishRecording. */
  function stopRecording(): void {
    const r = recRef.current
    if (!r || r.rec.state === 'inactive') return
    r.rec.stop()
  }

  /** Assemble the chunks, persist through IPC, release the streams. */
  async function finishRecording(): Promise<void> {
    const r = recRef.current
    if (!r) return
    recRef.current = null
    r.stopCrop?.()
    r.source.getTracks().forEach((t2) => t2.stop())
    setRecordingSince(null)
    setRecSaving(true)
    try {
      const blob = new Blob(r.chunks, { type: r.mime })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const path = await window.api.saveRecording(bytes, r.ext)
      if (path) showToast(tRef.current('toast.recordSaved', { path }), 'success', { raw: true })
      else showToast('toast.recordFailed', 'error')
    } catch (e) {
      window.api.reportError('browser', `recording: save failed: ${String(e)}`)
      showToast('toast.recordFailed', 'error')
    } finally {
      setRecSaving(false)
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
                {GLYPH_ACTIONS.screen}
              </button>
              <button
                type="button"
                className="tile-btn"
                title={t('browser.dockDetach')}
                onClick={() => setBrowserPaired(null)}
              >
                {GLYPH_ACTIONS.close}
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
            className={`browser-btn${mode === 'web' ? ' browser-btn-active' : ''}`}
            title={t('browser.modeWeb')}
            onClick={() => switchMode('web')}
          >
            {GLYPHS.browser}
          </button>
          <button
            type="button"
            className={`browser-btn${mode === 'window' ? ' browser-btn-active' : ''}`}
            title={t('browser.modeWindow')}
            onClick={() => switchMode('window')}
          >
            {GLYPH_ACTIONS.window}
          </button>
          {mode === 'web' && (
            <>
              <button
                type="button"
                className="browser-btn"
                title={t('browser.back')}
                disabled={!canBack}
                onClick={() => webviewRef.current?.goBack()}
              >
                {GLYPH_ACTIONS.back}
              </button>
              <button
                type="button"
                className="browser-btn"
                title={t('browser.forward')}
                disabled={!canFwd}
                onClick={() => webviewRef.current?.goForward()}
              >
                {GLYPH_ACTIONS.forward}
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
                {GLYPH_ACTIONS.refresh}
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
                onChange={(e) =>
                  setViewport(VIEWPORTS.find((v) => v.id === e.target.value) ?? null)
                }
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
                {GLYPH_ACTIONS.target}
              </button>
            </>
          )}
          {mode === 'window' && (
            <>
              <select
                className="browser-window-select"
                title={t('browser.modeWindow')}
                value={windowId}
                onChange={(e) => selectWindow(e.target.value)}
              >
                <option value="">{t('browser.windowSelect')}</option>
                {windows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`browser-btn${shotLoading ? ' browser-btn-loading' : ''}`}
                title={t('browser.windowRefresh')}
                onClick={() => {
                  void refreshWindows()
                  if (windowId) void captureShot(windowId)
                }}
              >
                {GLYPH_ACTIONS.refresh}
              </button>
            </>
          )}
          <button
            type="button"
            className={`browser-btn${drawing ? ' browser-btn-active' : ''}`}
            title={t('browser.draw')}
            disabled={mode === 'window' && !shot}
            onClick={toggleDraw}
          >
            {GLYPH_ACTIONS.edit}
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
                {GLYPH_ACTIONS.camera}
              </button>
              <button
                type="button"
                className="browser-btn"
                title={t('browser.drawClear')}
                onClick={clearDraw}
              >
                {GLYPH_ACTIONS.erase}
              </button>
            </>
          )}
          {mode === 'web' && (
            <>
              <button
                type="button"
                className="browser-btn"
                title={t('browser.devtools')}
                onClick={() => webviewRef.current?.openDevTools()}
              >
                {GLYPH_ACTIONS.code}
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
                {GLYPH_ACTIONS.external}
              </button>
            </>
          )}
          <button
            type="button"
            className={`browser-btn${recordingSince !== null ? ' browser-btn-rec' : ''}`}
            title={t(recordingSince !== null ? 'browser.recordStop' : 'browser.record')}
            disabled={recSaving}
            onClick={() => (recordingSince !== null ? stopRecording() : setRecDialog(true))}
          >
            {GLYPH_ACTIONS.record}
          </button>
          {recordingSince !== null && (
            <span className="browser-rec-time">{formatElapsed(recElapsed)}</span>
          )}
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
          {/* The webview never unmounts on a mode switch: page state survives. */}
          <div
            ref={browserFrameRef}
            className={`browser-frame${viewport ? ' browser-frame-device' : ''}${mode === 'window' ? ' view-hidden' : ''}`}
            style={viewport && mode === 'web' ? { width: viewport.w, height: viewport.h } : undefined}
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
            {drawing && mode === 'web' && (
              <canvas
                ref={canvasRef}
                className="browser-draw-canvas"
                onPointerDown={onDrawDown}
                onPointerMove={onDrawMove}
                onPointerUp={onDrawUp}
                onPointerCancel={onDrawUp}
              />
            )}
            {loadError && mode === 'web' && (
              <div className="browser-load-error" role="alert">
                <p>{t('browser.loadFailed')}</p>
                <p className="error-boundary-detail">{loadError}</p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setLoadError(null)
                    webviewRef.current?.reload()
                  }}
                >
                  {t('browser.reloadPage')}
                </button>
              </div>
            )}
          </div>
          {mode === 'window' &&
            (shot ? (
              <div className="browser-shot-wrap">
                <img className="browser-shot" src={shot.dataUrl} alt={shot.title} />
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
            ) : (
              <div className="browser-window-empty">{t('browser.windowEmpty')}</div>
            ))}
          {/* Webviews swallow mouse events; shield them while dragging the divider. */}
          {dragging && <div className="browser-drag-shield" />}
        </div>
      </div>
      {recDialog && (
        <div className="modal-backdrop" onMouseDown={() => setRecDialog(false)}>
          <div className="modal record-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{t('browser.recordTitle')}</h2>
            <p className="record-hint">{t('browser.recordHint')}</p>
            <label className="record-scope">
              <input
                type="radio"
                name="rec-scope"
                checked={recScope === 'browser'}
                onChange={() => setRecScope('browser')}
              />
              {t('browser.recordScopeBrowser')}
            </label>
            <label className="record-scope">
              <input
                type="radio"
                name="rec-scope"
                checked={recScope === 'window'}
                onChange={() => setRecScope('window')}
              />
              {t('browser.recordScopeWindow')}
            </label>
            <div className="modal-actions">
              <button onClick={() => setRecDialog(false)}>{t('common.cancel')}</button>
              <button className="primary" autoFocus onClick={() => void startRecording(recScope)}>
                {t('browser.recordStart')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
