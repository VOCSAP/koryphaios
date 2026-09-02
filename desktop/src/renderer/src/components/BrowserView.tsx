// Two entries dock the same pane: the rail's full-width browser, and a tile's
// browser button which docks a second xterm on the same PTY while the tile
// stays mounted in the hidden Agents view, so nothing is lost when leaving.
// Inspect mode injects an element description into the docked agent's prompt as
// a bracketed paste; draw mode pins a cropped, stroke-burned screenshot into
// the same review panel, and both send only through that panel's Send, never a
// button of their own.
// Window mode mirrors any OS window through the same draw-then-review flow;
// element picking stays web-only, so the sketch is what answers "which region"
// for native targets.

import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type {
  ElementPick,
  PickAnnotation,
  PickAnnotationIntent,
  PickAnnotationPriority,
  PickNote,
  PickRegion,
  SessionRuntime,
  WindowSource
} from '@shared/types'
import { REVIEW_STATE_VERSION } from '@shared/types'
import { formatAnnotationsReport, formatPickDetails } from '@shared/pick-prompt'
import { PICK_BUDGET, sanitizePickUrl } from '@shared/pick-security'
import { computeBoxCropRect, computeElementCropRect, PICK_SHOT_MAX_BYTES } from '@shared/pick-shot'
import { annotationToCardFields, pickNoteToCardSeed } from '@shared/pick-card'
import { paintStroke, strokeBounds, type DrawStroke, type DrawTool, clampBoundsToBox } from '@shared/draw-strokes'
import { createDrawModifierWatcher, type DrawModifierPlatform } from '@shared/draw-modifier'
import {
  computeCropRect,
  formatElapsed,
  pickRecorderMime,
  type RecordingScope
} from '@shared/recording'
import type { ModelTarget } from '@shared/graph'
import { targetKey, type ProviderCatalog } from '@shared/models'
import { ModelPicker } from './ModelPicker'
import { PickContextDialog } from './PickContextDialog'
import { ConfirmDialog } from './ConfirmDialog'
import type { WebviewIpcMessageEvent, WebviewNavigateEvent, WebviewTag } from '../webview-types'
import { GLYPHS, GLYPH_ACTIONS } from './icons'
import { errorText, useDeck } from '../store'
import { useT, type TFn } from '../i18n'

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
 * Guard an async IPC call the same shape as store.ts's own (module-private)
 * `guarded` (PLAN O6): report to main.log/journal AND toast the raw error,
 * never a silent catch. Re-implemented here rather than imported -- store.ts
 * keeps its `guarded` private to its own actions -- since this component's
 * review-persistence and roadmap-card calls are BrowserView's own IPC, not
 * store actions. Always resolves (never rejects): callers can `.finally()`
 * off it to run cleanup regardless of success or failure.
 */
async function guarded(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    const msg = errorText(e)
    try {
      window.api.reportError('browser', `${label} failed: ${msg}`)
    } catch {
      // Reporting must never mask the toast.
    }
    useDeck.getState().showToast(`${label}: ${msg}`, 'error', { raw: true })
  }
}

/** First `n` words of `text`, ellipsised when truncated -- the annotate-panel row label (Chantier OD5). */
function firstWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '')
}

/**
 * The `browser.elementPrompt` lead sentence, plus `browser.elementPromptText`
 * when the pick carried text -- the two i18n pieces every element-pick prompt
 * opens with, hoisted out so the pick-context-prompt-on branch (which delays
 * composing the rest of the prompt until Send) and the flag-off branch
 * (which composes it immediately, as before) build it identically instead of
 * duplicating the two calls.
 */
function composePickLead(pick: ElementPick, tt: TFn): string {
  const selector = pick.selectors[0]?.value ?? pick.tagName
  let lead = tt('browser.elementPrompt', {
    tag: pick.tagName,
    url: pick.pageUrl,
    selector,
    w: pick.width,
    h: pick.height
  })
  if (pick.text) lead += tt('browser.elementPromptText', { text: pick.text })
  return lead
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
  // Annotate review (Chantier OD5): multi-pick armed state + the pinned
  // batch. `pendingAnnotations` deliberately OUTLIVES `reviewArmed` going
  // false (Escape only disarms picking, per DESIGN.md's collapsing-must-not-
  // destroy-drafts rule) -- cleared only by Send or Discard.
  //
  // INVARIANT (rework of the draw mode, see "----- draw mode -----" below):
  // `reviewArmed` keeps its original, narrower meaning -- "the guest
  // multi-pick listener is armed" -- unchanged by draw mode. A completed
  // draw stroke pins straight into `pendingAnnotations` WITHOUT touching
  // `reviewArmed` at all: the panel's own visibility condition
  // (`reviewArmed || pendingAnnotations.length > 0`, see the JSX below)
  // already shows the panel off that push alone, so overloading this flag's
  // meaning would only make the review toolbar toggle (which reflects
  // `reviewArmed`) lie about whether the guest listener is actually armed.
  // Draw and review ARE, however, no longer mutually exclusive with EACH
  // OTHER any more (toggleDraw/toggleAnnotate below stopped disarming one
  // another) -- only INSPECT (single-element pick, `picking`) stays
  // mutually exclusive with BOTH, since picking and review-multi share the
  // same guest document listeners (shared/element-pick.ts) and the draw
  // canvas overlay would swallow the guest's pointer events regardless.
  const [reviewArmed, setReviewArmed] = useState(false)
  const [pendingAnnotations, setPendingAnnotations] = useState<PickAnnotation[]>([])
  // Review persistence (write-through effect further down): true once the
  // initial window.api.loadReview() has settled, success OR failure -- gates
  // the write-through so the empty INITIAL state (render before the load
  // resolves) can never save over/clear a persisted draft that just hasn't
  // loaded yet.
  const loadedRef = useRef(false)
  const reviewSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // "Create cards" confirm (Part B): armed by the panel button, cleared on
  // confirm/cancel. Not derived from pendingAnnotations.length alone since
  // the dialog itself must survive the count it was opened with.
  const [confirmCreateCards, setConfirmCreateCards] = useState(false)
  // Pick-context dialog (`pickContextPrompt` flag): the pick awaiting an
  // operator note before its prompt is composed and delivered. A fresh pick
  // arriving while one is already pending REPLACES it outright (last pick
  // wins, no queue) -- `id` is how the in-flight capture below tells whether
  // it is still writing into the CURRENT pending pick or a since-replaced one.
  const [pendingPick, setPendingPick] = useState<{
    id: string
    pick: ElementPick
    shot: 'pending' | 'ready' | 'none'
    shotPath: string | null
  } | null>(null)
  // Always holds the in-flight (or already-settled) capture promise for the
  // CURRENT pendingPick -- reassigned synchronously the moment a new pick
  // replaces the old one, so onSend below always awaits the right one.
  const pendingPickCaptureRef = useRef<Promise<string | null> | null>(null)
  // Guards the capture's .then callback against calling setState after this
  // view has unmounted (e.g. the operator left the browser view mid-capture).
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])
  const [viewport, setViewport] = useState<ViewportPreset | null>(null)
  // Draw mode: `drawing` is the TOOLBAR toggle (stays on until the operator
  // turns it off or Escapes); `guestHold`/`hostHold` are the two independent
  // hold-to-draw signals merged into `holdHeld` below -- see the "hold
  // watchers" effects further down and draw-modifier.ts's own doc comment
  // for why there have to be two. The canvas overlay renders on
  // `drawing || holdHeld`.
  const [drawing, setDrawing] = useState(false)
  const [drawTool, setDrawTool] = useState<DrawTool>('freehand')
  const [guestHold, setGuestHold] = useState(false)
  const [hostHold, setHostHold] = useState(false)
  // Window-mirror mode (D2a). The webview stays mounted (hidden) meanwhile.
  const [mode, setMode] = useState<'web' | 'window'>('web')
  // Hold-to-draw is web-mode only: the window-mirror's still isn't
  // interactive, so a hold over it means nothing -- computed here, after
  // `mode`, rather than folded into the two flags above.
  const holdHeld = mode === 'web' && (guestHold || hostHold)
  const [windows, setWindows] = useState<WindowSource[]>([])
  const [windowId, setWindowId] = useState('')
  const [shot, setShot] = useState<{ dataUrl: string; title: string } | null>(null)
  const [shotLoading, setShotLoading] = useState(false)
  const [dockWidth, setDockWidth] = useState(520)
  const [dragging, setDragging] = useState(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokingRef = useRef(false)
  // The CURRENT in-progress stroke only (points accumulated on pointer move,
  // repainted from scratch on every move so the circle tool's live preview
  // tracks the drag) -- completed strokes are never kept here: each one is
  // pinned into `pendingAnnotations` as its own region annotation the moment
  // it finishes (pinRegionStroke), then the canvas is cleared. null when no
  // stroke is in progress.
  const activeStrokeRef = useRef<DrawStroke | null>(null)
  // Screen recording (REC). recordingSince lives in the store so the nav rail
  // can show the indicator from any view (this component stays mounted).
  const recordingSince = useDeck((s) => s.recordingSince)
  const setRecordingSince = useDeck((s) => s.setRecordingSince)
  const [recDialog, setRecDialog] = useState(false)
  const [recScope, setRecScope] = useState<RecordingScope>('browser')
  const [recElapsed, setRecElapsed] = useState(0)
  const [recSaving, setRecSaving] = useState(false)
  // Scripted scenario (demo driver): optional prompt + claude-only target.
  const [recScenario, setRecScenario] = useState('')
  const [recTarget, setRecTarget] = useState<ModelTarget | null>(null)
  const [recCatalogs, setRecCatalogs] = useState<ProviderCatalog[] | null>(null)
  const [demoBusy, setDemoBusy] = useState(false)
  const demoBusyRef = useRef(false)
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

  // Review persistence (main/review-state-service.ts), load half: restore a
  // draft left over from a previous window reload / app restart. Same
  // "once, on mount" shape as the preload-path load above. Screenshot paths
  // on a restored annotation are already containment- and existence-checked
  // main-side (validatePersistedReview drops an unsafe/stale one silently)
  // -- nothing to re-check here in the renderer.
  useEffect(() => {
    void guarded('review-load', async () => {
      const state = await window.api.loadReview()
      if (!mountedRef.current || !state || state.annotations.length === 0) return
      // The operator could in principle pin something (a fast pick, a hold-
      // to-draw stroke) before this resolves -- unlikely, since it fires on
      // mount before the webview/preload is even attached, but possible if
      // the load itself is slow. Prefer whatever is already live rather than
      // clobbering it with the persisted draft.
      setPendingAnnotations((prev) => (prev.length > 0 ? prev : state.annotations))
    }).finally(() => {
      loadedRef.current = true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Review persistence, write-through half: save on every change, debounced
  // (a comment keystroke or a pin/pin/pin burst must not fire an IPC + disk
  // write per character/pick). Gated on `loadedRef` -- see its own comment --
  // so the pre-load empty render can never clobber a real persisted draft.
  // `sendReview`/`discardReview` ALSO call clearReview() directly, not just
  // through this effect: Send/Discard are definitive actions, so the file
  // should be gone the instant either fires, not lag by up to the debounce.
  useEffect(() => {
    if (!loadedRef.current) return
    if (reviewSaveTimer.current) clearTimeout(reviewSaveTimer.current)
    reviewSaveTimer.current = setTimeout(() => {
      if (pendingAnnotations.length === 0) {
        void guarded('review-save', () => window.api.clearReview())
        return
      }
      void guarded('review-save', () =>
        window.api.saveReview({
          version: REVIEW_STATE_VERSION,
          pageUrl: sanitizePickUrl(webviewRef.current?.getURL() || urlText),
          annotations: pendingAnnotations
        })
      )
      // saveReview rejects with 'invalid review state' when main's strict
      // validator refuses the payload (review-state-service.ts) -- that
      // is a real bug signal (the renderer built something the validator
      // doesn't accept), and `guarded` surfaces it rather than swallowing it.
    }, 300)
    return () => {
      if (reviewSaveTimer.current) clearTimeout(reviewSaveTimer.current)
    }
  }, [pendingAnnotations])

  // Keep latest values available to the stable webview listeners.
  const pairedRef = useRef(paired)
  pairedRef.current = paired
  const tRef = useRef(t)
  tRef.current = t
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  // Read fresh inside the stable webview ipc-message listener (same reason as
  // the refs above): the cap check on a new annotation must see the latest
  // list, not the one captured when the effect was set up.
  const pendingAnnotationsRef = useRef(pendingAnnotations)
  pendingAnnotationsRef.current = pendingAnnotations

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

  /**
   * Capture -> decode -> crop -> byte-cap -> save a screenshot of a picked
   * element (Chantier OD4 body). Shared by two callers: the auto-shot fired
   * on every pick below, and the S hover-shortcut's screenshot-only pick
   * (Chantier OD6, `deck:element-shot`). Reads webviewRef.current fresh at
   * call time rather than taking the webview as a parameter, so both callers
   * stay simple. ANY failure at any step degrades silently to null here --
   * what each caller does with that null differs (see their own comments),
   * so this helper itself makes no toast/UI decision.
   */
  async function captureElementShot(pick: ElementPick): Promise<string | null> {
    const wv = webviewRef.current
    if (!wv) return null
    try {
      const dataUrl = await window.api.captureBrowser(wv.getWebContentsId())
      if (!dataUrl) throw new Error('capture: empty')
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('capture: decode failed'))
        img.src = dataUrl
      })
      const crop = computeElementCropRect(pick, img.naturalWidth, img.naturalHeight, wv.clientWidth)
      if (!crop) throw new Error('capture: no crop rect')
      const out = document.createElement('canvas')
      out.width = crop.sw
      out.height = crop.sh
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('capture: no 2d context')
      ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh)
      const shotDataUrl = out.toDataURL('image/png')
      // base64 inflates raw bytes by 4/3 (3 bytes -> 4 chars): cap the
      // STRING length at that ratio of the byte budget rather than
      // decoding first, so an oversized crop never reaches saveAnnotation.
      const base64Len = shotDataUrl.length - (shotDataUrl.indexOf(',') + 1)
      if (base64Len > (PICK_SHOT_MAX_BYTES * 4) / 3) throw new Error('capture: over budget')
      return await window.api.saveAnnotation(shotDataUrl)
    } catch {
      return null
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
      if (ev.channel === 'deck:review-inspect-ended') {
        // Escape (or the host itself) disarmed the multi-pick guest listener.
        // The pending batch is untouched -- only Send/Discard clear it.
        setReviewArmed(false)
        return
      }
      if (ev.channel === 'deck:draw-modifier') {
        // Hold-to-draw, GUEST half (preload/browser-inspect.ts): the
        // pointer/focus is over the PAGE. Merged with the host-side watcher
        // into `holdHeld` -- see that computation's own comment for why both
        // are needed.
        setGuestHold(Boolean(ev.args[0]))
        return
      }
      if (ev.channel === 'deck:annotation-picked') {
        // Annotate review (Chantier OD5): pin the pick, best-effort auto
        // screenshot (same helper as the single-pick path below), refuse
        // past the per-page cap with a toast rather than silently dropping.
        const pick = ev.args[0] as ElementPick
        if (pendingAnnotationsRef.current.length >= PICK_BUDGET.annotationsMaxPerPage) {
          showToast('toast.annotationCapReached', 'info')
          return
        }
        const id = crypto.randomUUID()
        const annotation: PickAnnotation = {
          id,
          comment: '',
          intent: 'change',
          priority: 'suggestion',
          pick
        }
        setPendingAnnotations((prev) => [...prev, annotation])
        void (async () => {
          const shotPath = await captureElementShot(pick)
          if (shotPath) {
            setPendingAnnotations((prev) =>
              prev.map((a) => (a.id === id ? { ...a, screenshotPath: shotPath } : a))
            )
          }
        })()
        return
      }
      if (ev.channel === 'deck:element-shot') {
        // S hover-shortcut (Chantier OD6, DESIGN-ORCA-DOOP-ADOPTION.md §3.6):
        // screenshot the hovered element without ever clicking it. The guest
        // exits inspect mode on S exactly like on a pick (createInspectMode's
        // onShot -> exit() -> onExit() -> a separate 'deck:inspect-ended'
        // message), same as deck:element-selected below -- unpress the pick
        // button here too rather than waiting on that second message.
        setPicking(false)
        const pick = ev.args[0] as ElementPick
        const tt = tRef.current
        void (async () => {
          const shotPath = await captureElementShot(pick)
          if (shotPath) {
            const prompt =
              tt('browser.elementShotOnly', {
                url: pick.pageUrl,
                tag: pick.tagName,
                w: pick.width,
                h: pick.height,
                selector: pick.selectors[0]?.value ?? pick.tagName,
                path: shotPath
              }) + viewportContext()
            deliverPrompt(prompt, 'toast.pickSent', 'toast.pickCopied')
          } else {
            // Unlike the OD4 auto-shot below, here the screenshot IS the
            // deliverable -- a silent failure would leave the operator
            // waiting on nothing, so this one surfaces.
            showToast('toast.shotFailed', 'info')
          }
        })()
        return
      }
      if (ev.channel !== 'deck:element-selected') return
      const pick = ev.args[0] as ElementPick
      const tt = tRef.current

      // Pick-context dialog (`pickContextPrompt` flag, DeckConfig): read
      // fresh via getState() rather than a stale render-time value/closure,
      // same discipline as pendingAnnotationsRef above. Nothing is composed
      // or delivered here -- the dialog does that on Send, once the operator
      // has had a chance to add a note.
      if (useDeck.getState().pickContextPrompt) {
        const id = crypto.randomUUID()
        // Unconditional overwrite: a second pick while one is pending
        // REPLACES the older one (documented on the state declaration above).
        setPendingPick({ id, pick, shot: 'pending', shotPath: null })
        // Same precondition as the OD4 auto-shot capture on the flag-off
        // branch below, and the same highlight-free-by-construction
        // guarantee applies (see that branch's comment, still true here).
        if (webviewRef.current && pick.x !== undefined && pick.y !== undefined) {
          const capture = (async () => {
            const shotPath = await captureElementShot(pick)
            // Guard against a dangling write: this view unmounted, or a
            // newer pick already replaced this one, while the capture was
            // still in flight.
            if (mountedRef.current) {
              setPendingPick((prev) =>
                prev && prev.id === id ? { ...prev, shot: shotPath ? 'ready' : 'none', shotPath } : prev
              )
            }
            return shotPath
          })()
          pendingPickCaptureRef.current = capture
        } else {
          pendingPickCaptureRef.current = Promise.resolve(null)
          setPendingPick((prev) => (prev && prev.id === id ? { ...prev, shot: 'none' } : prev))
        }
        return
      }

      let prompt = composePickLead(pick, tt)
      prompt += formatPickDetails(pick)
      prompt += viewportContext()

      // Best-effort screenshot only: any failure at any step degrades silently
      // to delivering the prompt unchanged, since the pick itself already
      // succeeded and a missing screenshot is a normal race, not an error worth
      // a toast.
      // Highlight-free by construction: the guest's onClick posts this pick and
      // then calls exit() synchronously before returning to the event loop, so
      // the highlight is already restored by the time this listener — let alone
      // the async capture — runs.
      if (webviewRef.current && pick.x !== undefined && pick.y !== undefined) {
        // Keep this handler itself synchronous (no `async` on onIpc): the
        // capture is fired as a detached IIFE so the ipc-message listener
        // returns immediately, matching every other listener in this effect.
        void (async () => {
          const shotPath = await captureElementShot(pick)
          const delivered = shotPath ? prompt + tt('browser.elementShotPrompt', { path: shotPath }) : prompt
          deliverPrompt(delivered, 'toast.pickSent', 'toast.pickCopied')
        })()
        return
      }
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

  /** Pick-context dialog Send: composes the same prompt shape the flag-off
   *  path would have delivered directly, with the operator's note folded in
   *  via `formatPickDetails`'s `note` parameter. */
  async function sendPendingPick(note: PickNote, dontAskAgain: boolean): Promise<void> {
    const current = pendingPick
    if (!current) return
    const tt = tRef.current
    // Close the dialog BEFORE awaiting the capture: a second Ctrl+Enter or
    // click during the await would otherwise re-enter here with the same
    // `pendingPick` and deliver the prompt twice. The capture promise is
    // pinned locally so a pick arriving during the await cannot swap it.
    const capture = pendingPickCaptureRef.current ?? Promise.resolve(null)
    setPendingPick(null)
    if (dontAskAgain) useDeck.getState().setPickContextPrompt(false)
    // Always resolves (captureElementShot's own try/catch, or the
    // Promise.resolve(null) set when the capture precondition failed).
    const shotPath = await capture
    let prompt = composePickLead(current.pick, tt)
    prompt += formatPickDetails(current.pick, note)
    prompt += viewportContext()
    if (shotPath) prompt += tt('browser.elementShotPrompt', { path: shotPath })
    deliverPrompt(prompt, 'toast.pickSent', 'toast.pickCopied')
  }

  /** Pick-context dialog Cancel: discard the pick, no toast. */
  function cancelPendingPick(): void {
    setPendingPick(null)
  }

  /**
   * Pick-context dialog "Create a card" (Part B entry point 1): the pick is
   * CONSUMED by the draft, no prompt is sent -- unlike Send, which composes
   * and delivers a prompt from the same note. openRoadmapDraft only switches
   * the view and pre-fills the create form; nothing is written until the
   * operator saves it there.
   */
  function createPendingPickCard(note: PickNote): void {
    const current = pendingPick
    if (!current) return
    const url = sanitizePickUrl(webviewRef.current?.getURL() || urlText)
    const seed = pickNoteToCardSeed(current.pick, note, { url })
    useDeck.getState().openRoadmapDraft(seed)
    setPendingPick(null)
  }

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
    // INSPECT stays mutually exclusive with draw (see the invariant comment
    // on `reviewArmed`'s declaration above) -- the canvas overlay would
    // swallow the guest's own mouseover/click either way.
    if (drawing) exitDraw()
    // Single-pick and review-pick share the same guest document listeners
    // (shared/element-pick.ts) -- never arm both at once.
    if (!picking && reviewArmed) exitReview()
    try {
      wv.send(picking ? 'deck:exit-inspect' : 'deck:enter-inspect')
      setPicking(!picking)
    } catch {
      /* webview not attached yet (page still loading) */
    }
  }

  /** Send 'deck:exit-inspect-multi' and clear the armed flag; the pending batch survives. */
  function exitReview(): void {
    try {
      webviewRef.current?.send('deck:exit-inspect-multi')
    } catch {
      /* not attached */
    }
    setReviewArmed(false)
  }

  /**
   * Annotate review toggle (Chantier OD5): arms/disarms the multi-pick guest
   * listener. Does NOT touch draw mode any more (see the invariant comment
   * on `reviewArmed`'s declaration above) -- a stroke drawn while the review
   * guest listener is armed pins straight into the same panel this arms.
   */
  function toggleAnnotate(): void {
    const wv = webviewRef.current
    if (!wv) return
    if (reviewArmed) {
      exitReview()
      return
    }
    if (picking) {
      try {
        wv.send('deck:exit-inspect')
      } catch {
        /* not attached */
      }
      setPicking(false)
    }
    try {
      wv.send('deck:enter-inspect-multi')
      setReviewArmed(true)
    } catch {
      /* webview not attached yet (page still loading) */
    }
  }

  function updateAnnotation(id: string, patch: Partial<Pick<PickAnnotation, 'comment' | 'intent' | 'priority'>>): void {
    setPendingAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  function removeAnnotation(id: string): void {
    setPendingAnnotations((prev) => prev.filter((a) => a.id !== id))
  }

  /** Footer "Send review (N)": one structured message, then clear + disarm. */
  function sendReview(): void {
    if (!pendingAnnotations.length) return
    const wv = webviewRef.current
    const report = formatAnnotationsReport(pendingAnnotations, {
      // sanitizePickUrl strips query/fragment (pick-security.ts's written
      // guarantee) -- a review sent from an OAuth callback page must never
      // carry its token into the agent prompt via the page URL.
      url: sanitizePickUrl(wv?.getURL() || urlText),
      viewport: viewport ? `${viewport.w}x${viewport.h} – ${viewport.name}` : undefined
    })
    deliverPrompt(report, 'toast.reviewSent', 'toast.reviewCopied')
    setPendingAnnotations([])
    if (reviewArmed) exitReview()
    // Clear the persisted draft NOW: the write-through effect above would
    // also clear it once pendingAnnotations goes empty, but only after its
    // ~300ms debounce -- Send is definitive, the file should be gone the
    // instant it fires (e.g. an immediate app quit right after), not lag.
    void guarded('review-clear', () => window.api.clearReview())
  }

  /** Footer "Discard": clears the batch without sending anything. */
  function discardReview(): void {
    setPendingAnnotations([])
    if (reviewArmed) exitReview()
    // Same immediacy reasoning as sendReview's explicit clear above.
    void guarded('review-clear', () => window.api.clearReview())
  }

  /**
   * One roadmapUpsert per pinned finding, sequential inside a single guarded
   * call — not Promise.all — so a mid-batch failure stops the loop instead of
   * firing the rest at an already-erroring broker.
   * Cards created before that failure stay created; there is no rollback or
   * retry, and the success toast only fires when created equals total.
   * The review itself is left untouched either way, so the operator can still
   * Send it afterwards.
   */
  async function createReviewCards(): Promise<void> {
    const wv = webviewRef.current
    const page = {
      url: sanitizePickUrl(wv?.getURL() || urlText),
      viewport: viewport ? `${viewport.w}x${viewport.h} – ${viewport.name}` : undefined
    }
    const total = pendingAnnotations.length
    let created = 0
    await guarded('review-cards', async () => {
      for (const a of pendingAnnotations) {
        await window.api.roadmapUpsert(annotationToCardFields(a, page))
        created++
      }
    })
    if (created === total) {
      showToast(tRef.current('toast.reviewCardsCreated', { n: created }), 'success', { raw: true })
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
    if (reviewArmed) exitReview()
    // Unconditional (not gated on `drawing`): a mode switch must also abort
    // a HOLD-ONLY stroke -- `holdHeld` itself is gated to web mode, so it
    // goes false on its own once `mode` changes, but that alone would leave
    // a stale in-progress stroke in the refs and un-cleared canvas pixels.
    strokingRef.current = false
    activeStrokeRef.current = null
    clearCanvasPixels()
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

  // ----- draw mode -----
  //
  // Rework: sending a whole-page composite (the old sendAnnotation) is gone.
  // Every COMPLETED stroke (pointer-up with >= 2 points, or a hold ending
  // mid-stroke) becomes its own region PickAnnotation, pinned into the same
  // review panel an element pick fills, with a cropped screenshot that has
  // the stroke burned in (captureRegionShot below) -- sending is the
  // review panel's existing "Send review" (sendReview above), never a
  // draw-mode button of its own. The canvas itself only ever shows the ONE
  // in-progress stroke (`activeStrokeRef`); a completed stroke is cleared
  // off it the instant it is pinned, same as a pick never leaves a mark on
  // the guest page.

  function clearCanvasPixels(): void {
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }

  function exitDraw(): void {
    setDrawing(false)
    strokingRef.current = false
    activeStrokeRef.current = null
    clearCanvasPixels()
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

  /** Size the canvas to its box; called on mount and box resize (a resize discards any in-progress stroke -- its points are no longer meaningful against the new size). */
  function fitCanvas(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w
      canvas.height = h
      strokingRef.current = false
      activeStrokeRef.current = null
    }
  }

  // Canvas overlay is visible on `drawing || holdHeld` (window mode: `drawing`
  // only, per the `holdHeld` computation above). Escape exits the toolbar
  // draw mode AND aborts a hold-only stroke -- same teardown either way.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!(drawing || holdHeld) || !canvas) return
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
  }, [drawing, holdHeld])

  // ----- hold-to-draw watchers -----
  //
  // Two independent sources merged into `holdHeld` (declared above, next to
  // `mode`): the GUEST message (the pointer started over the page, before
  // the canvas existed to steal focus) and this HOST watcher (the pointer/
  // focus is over the canvas/toolbar once it is up, which the guest cannot
  // see at all -- it is a separate webContents). Both stay installed for the
  // whole life of the component, not just while drawing, so whichever one
  // sees the keydown FIRST is the one that shows the canvas.
  const holdPlatformRef = useRef<DrawModifierPlatform>(
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? 'mac' : 'other'
  )
  useEffect(() => {
    return createDrawModifierWatcher(window, holdPlatformRef.current, (held) => {
      setHostHold(held)
      // A keyup seen HERE means the physical key is up, whatever the guest
      // last reported: once the canvas is up and the operator presses on it,
      // focus moves to the host and the guest never sees that keyup (its own
      // window-blur release in preload/browser-inspect.ts is the other half
      // of this pair). Without this line the canvas could stay up until the
      // guest regained focus and saw a fresh keydown/keyup cycle.
      if (!held) setGuestHold(false)
    })
  }, [])

  /**
   * A hold ending mid-stroke finishes it like a pointer-up, rather than
   * dropping it -- the operator already drew something. Only applies to a
   * HOLD-ONLY stroke: if the toolbar `drawing` mode is also on, the canvas
   * stays up regardless of the hold, so the stroke keeps going. Guarded on
   * `strokingRef` (not `activeStrokeRef` alone) so a hold ending with no
   * stroke in progress is a no-op.
   */
  useEffect(() => {
    if (!holdHeld && !drawing && strokingRef.current) finishActiveStroke()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdHeld, drawing])

  function strokePos(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function repaintActiveStroke(): void {
    const canvas = canvasRef.current
    const stroke = activeStrokeRef.current
    if (!canvas || !stroke) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    paintStroke(ctx, stroke, 1, { color: DRAW_STROKE, lineWidth: 3 })
  }

  function onDrawDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    strokingRef.current = true
    const { x, y } = strokePos(e)
    activeStrokeRef.current = { tool: drawTool, points: [{ x, y }] }
  }

  function onDrawMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!strokingRef.current || !activeStrokeRef.current) return
    const { x, y } = strokePos(e)
    activeStrokeRef.current.points.push({ x, y })
    // Redrawn from scratch every move (not an incremental lineTo, unlike the
    // old freehand-only canvas): the circle tool's preview has to move its
    // WHOLE ellipse as the drag continues, not append to a path.
    repaintActiveStroke()
  }

  /** Pointer-up: complete the stroke (pin it if it has >= 2 points). */
  function onDrawUp(): void {
    finishActiveStroke()
  }

  /** Pointer-cancel (palm rejection, system interrupt): abort, never pin a stroke the operator did not actually finish. */
  function onDrawCancel(): void {
    strokingRef.current = false
    activeStrokeRef.current = null
    clearCanvasPixels()
  }

  function finishActiveStroke(): void {
    strokingRef.current = false
    const stroke = activeStrokeRef.current
    activeStrokeRef.current = null
    if (stroke && stroke.points.length >= 2) pinRegionStroke(stroke)
    else clearCanvasPixels()
  }

  /** Toolbar "Clear": aborts the in-progress stroke and blanks the canvas. Completed strokes are never on it (see the section comment above) -- there is nothing else to clear. */
  function clearDraw(): void {
    strokingRef.current = false
    activeStrokeRef.current = null
    clearCanvasPixels()
  }

  /**
   * One completed stroke -> one region PickAnnotation, pinned exactly like
   * the element-pick review handler (deck:annotation-picked in onIpc above):
   * same cap check, same shape of pinned record, same best-effort async
   * screenshot. `finishActiveStroke` already checked >= 2 points before
   * calling this, so `strokeBounds` returning null here can only mean a
   * non-finite pointer coordinate slipped through -- aborted silently, same
   * fail-closed posture as `strokeBounds` itself (draw-strokes.ts). The cap
   * being reached is the one case that DOES toast, since the operator
   * visibly drew something that then went nowhere.
   */
  function pinRegionStroke(stroke: DrawStroke): void {
    if (pendingAnnotationsRef.current.length >= PICK_BUDGET.annotationsMaxPerPage) {
      showToast('toast.annotationCapReached', 'info')
      clearCanvasPixels()
      return
    }
    const bounds = strokeBounds(stroke)
    if (!bounds) {
      clearCanvasPixels()
      return
    }
    // Persist and report the part of the stroke that is actually on screen:
    // raw bounds can be negative (drag started off-canvas) and main's
    // review-state validator refuses those, which would fail every later
    // save of the whole review (see clampBoundsToBox's comment). The raw
    // bounds still feed the capture below, whose crop clamps on its own.
    const canvas = canvasRef.current
    const visible = canvas ? clampBoundsToBox(bounds, canvas.clientWidth, canvas.clientHeight) : null
    if (!visible) {
      clearCanvasPixels()
      return
    }
    const pageUrl =
      mode === 'web' ? sanitizePickUrl(webviewRef.current?.getURL() || urlText) : ''
    const region: PickRegion = { ...visible, tool: stroke.tool, pageUrl }
    const id = crypto.randomUUID()
    const annotation: PickAnnotation = {
      id,
      comment: '',
      intent: 'change',
      priority: 'suggestion',
      region
    }
    setPendingAnnotations((prev) => [...prev, annotation])
    showToast('toast.regionPinned')
    // Each stroke stands alone (like a pick): clear the live canvas the
    // instant it is pinned, not after the async capture below settles.
    clearCanvasPixels()
    // viewportCssW captured NOW (synchronously, same render the stroke was
    // drawn against) rather than re-read inside the async capture -- a
    // window resize mid-capture must not retroactively change the space the
    // stroke's own points are interpreted in.
    const viewportCssW =
      mode === 'web' ? (webviewRef.current?.clientWidth ?? 0) : (canvasRef.current?.clientWidth ?? 0)
    void captureRegionShot(stroke, bounds, id, viewportCssW)
  }

  /**
   * Region screenshot pipeline: capture -> decode -> crop (computeBoxCropRect,
   * the stroke's OWN bounds rather than a picked element's) -> burn the
   * stroke back onto the crop (paintStroke, translated so the crop's own
   * origin lands at the output's 0,0) -> byte-cap -> save. Mirrors
   * captureElementShot's shape (Chantier OD4) with one deliberate
   * difference: unlike that best-effort auto-shot, the screenshot here IS
   * the region's main evidence (a region carries no selector/HTML an agent
   * could otherwise use to find it), so failure is NOT silent -- it reports
   * (window.api.reportError) and toasts (toast.shotFailed), leaving the
   * annotation pinned without a screenshot rather than dropping it.
   */
  async function captureRegionShot(
    stroke: DrawStroke,
    bounds: { x: number; y: number; width: number; height: number },
    annotationId: string,
    viewportCssW: number
  ): Promise<void> {
    try {
      const wv = webviewRef.current
      let dataUrl: string | null
      if (mode === 'web') {
        if (!wv) throw new Error('capture: no webview')
        dataUrl = await window.api.captureBrowser(wv.getWebContentsId())
      } else {
        if (!shot) throw new Error('capture: no window still')
        dataUrl = shot.dataUrl
      }
      if (!dataUrl) throw new Error('capture: empty')
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('capture: decode failed'))
        img.src = dataUrl!
      })
      const crop = computeBoxCropRect(bounds, img.naturalWidth, img.naturalHeight, viewportCssW)
      if (!crop) throw new Error('capture: no crop rect')
      const out = document.createElement('canvas')
      out.width = crop.sw
      out.height = crop.sh
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('capture: no 2d context')
      ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh)
      // Same empirical scale computeBoxCropRect used internally; the crop's
      // own origin (bitmap px) converted back to CSS px is exactly the
      // translation the stroke's points need so they land in the output
      // canvas's own coordinate space.
      const scale = img.naturalWidth / viewportCssW
      const translated: DrawStroke = {
        tool: stroke.tool,
        points: stroke.points.map((p) => ({ x: p.x - crop.sx / scale, y: p.y - crop.sy / scale }))
      }
      paintStroke(ctx, translated, scale, { color: DRAW_STROKE, lineWidth: 3 })
      const shotDataUrl = out.toDataURL('image/png')
      // base64 inflates raw bytes by 4/3 -- same cap discipline as
      // captureElementShot (pick-shot.ts's PICK_SHOT_MAX_BYTES).
      const base64Len = shotDataUrl.length - (shotDataUrl.indexOf(',') + 1)
      if (base64Len > (PICK_SHOT_MAX_BYTES * 4) / 3) throw new Error('capture: over budget')
      const shotPath = await window.api.saveAnnotation(shotDataUrl)
      if (!shotPath) throw new Error('capture: save failed')
      if (mountedRef.current) {
        setPendingAnnotations((prev) =>
          prev.map((a) => (a.id === annotationId ? { ...a, screenshotPath: shotPath } : a))
        )
      }
    } catch (e) {
      window.api.reportError('browser', `region capture failed: ${String(e)}`)
      showToast('toast.shotFailed', 'info')
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

  /** Model catalogs for the scenario picker, fetched when the dialog opens. */
  useEffect(() => {
    if (recDialog && recCatalogs === null) {
      void window.api.modelCatalogs().then(setRecCatalogs)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recDialog])

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
    // Stopping mid-scenario also cancels the demo agent (its run promise
    // rejects as cancelled; the video captured so far is still saved).
    if (demoBusyRef.current) void window.api.cancelDemoScenario()
    const r = recRef.current
    if (!r || r.rec.state === 'inactive') return
    r.rec.stop()
  }

  /**
   * Dialog Start: begin recording, then (scenario text present) hand the
   * scenario to the demo-driver agent and auto-stop when it finishes — the
   * whole agent-driven demo lands in one clip without operator timing.
   */
  async function startFromDialog(): Promise<void> {
    const scenario = recScenario.trim()
    const target = recTarget ?? config.demoTarget
    setRecDialog(false)
    await startRecording(recScope)
    if (!scenario || recRef.current === null) return
    const wv = webviewRef.current
    if (!wv) return
    demoBusyRef.current = true
    setDemoBusy(true)
    void window.api.setConfig({ demoTarget: target }) // remember the picker choice
    try {
      await window.api.runDemoScenario(wv.getWebContentsId(), scenario, target)
      showToast('toast.demoDone')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('cancelled')) {
        window.api.reportError('browser', `demo scenario failed: ${msg}`)
        showToast('toast.demoFailed', 'error')
      }
    } finally {
      demoBusyRef.current = false
      setDemoBusy(false)
      stopRecording()
    }
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
              <span
                className={`dot dot-${paired.status}${paired.activity === 'working' ? ' dot-thinking' : paired.activity === 'unknown' ? ' dot-unknown' : ''}`}
              />
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
              <button
                type="button"
                className={`browser-btn${reviewArmed ? ' browser-btn-active' : ''}`}
                title={t('browser.annotateReview')}
                onClick={toggleAnnotate}
              >
                {GLYPH_ACTIONS.checklist}
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
            className={`browser-btn${drawTool === 'freehand' ? ' browser-btn-active' : ''}`}
            title={t('browser.drawToolFreehand')}
            onClick={() => setDrawTool('freehand')}
          >
            {t('browser.drawToolFreehand')}
          </button>
          <button
            type="button"
            className={`browser-btn${drawTool === 'circle' ? ' browser-btn-active' : ''}`}
            title={t('browser.drawToolCircle')}
            onClick={() => setDrawTool('circle')}
          >
            {t('browser.drawToolCircle')}
          </button>
          <button
            type="button"
            className={`browser-btn${drawing ? ' browser-btn-active' : ''}`}
            title={t('browser.drawHoldHint')}
            aria-label={t('browser.draw')}
            disabled={mode === 'window' && !shot}
            onClick={toggleDraw}
          >
            {GLYPH_ACTIONS.edit}
          </button>
          {(drawing || holdHeld) && (
            <button
              type="button"
              className="browser-btn"
              title={t('browser.drawClear')}
              onClick={clearDraw}
            >
              {GLYPH_ACTIONS.erase}
            </button>
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
            <span
              className={`browser-rec-time${demoBusy ? ' rec-demo' : ''}`}
              title={demoBusy ? t('browser.recordDemoRunning') : undefined}
            >
              {formatElapsed(recElapsed)}
            </span>
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
            {(drawing || holdHeld) && mode === 'web' && (
              <canvas
                ref={canvasRef}
                className="browser-draw-canvas"
                title={t('browser.drawHoldHint')}
                onPointerDown={onDrawDown}
                onPointerMove={onDrawMove}
                onPointerUp={onDrawUp}
                onPointerCancel={onDrawCancel}
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
                    title={t('browser.drawHoldHint')}
                    onPointerDown={onDrawDown}
                    onPointerMove={onDrawMove}
                    onPointerUp={onDrawUp}
                    onPointerCancel={onDrawCancel}
                  />
                )}
              </div>
            ) : (
              <div className="browser-window-empty">{t('browser.windowEmpty')}</div>
            ))}
          {/* Webviews swallow mouse events; shield them while dragging the divider. */}
          {dragging && <div className="browser-drag-shield" />}
          {(reviewArmed || pendingAnnotations.length > 0) && (
            <div className="annotate-panel">
              <div className="annotate-panel-head">
                <span className="annotate-panel-title">{t('browser.annotatePanelTitle')}</span>
                <span className="annotate-panel-count">{pendingAnnotations.length}</span>
              </div>
              <div className="annotate-panel-list">
                {pendingAnnotations.length === 0 ? (
                  <p className="annotate-panel-empty">{t('browser.annotateEmpty')}</p>
                ) : (
                  pendingAnnotations.map((a) => (
                    <div key={a.id} className="annotate-row">
                      <div className="annotate-row-head">
                        <span className="annotate-row-label">
                          {a.pick ? a.pick.tagName : t('browser.annotateRegionLabel')}
                          {a.comment.trim() ? ` — ${firstWords(a.comment, 6)}` : ''}
                        </span>
                        <button
                          type="button"
                          className="icon-btn danger annotate-row-remove"
                          title={t('browser.annotateRemove')}
                          onClick={() => removeAnnotation(a.id)}
                        >
                          {GLYPH_ACTIONS.trash}
                        </button>
                      </div>
                      <textarea
                        className="annotate-comment"
                        rows={2}
                        maxLength={PICK_BUDGET.annotationCommentMaxLength}
                        placeholder={t('browser.annotateCommentPlaceholder')}
                        value={a.comment}
                        onChange={(e) => updateAnnotation(a.id, { comment: e.target.value })}
                      />
                      <div className="annotate-row-selects">
                        <select
                          className="annotate-select"
                          title={t('browser.annotateIntentLabel')}
                          value={a.intent}
                          onChange={(e) =>
                            updateAnnotation(a.id, { intent: e.target.value as PickAnnotationIntent })
                          }
                        >
                          <option value="fix">{t('browser.annotateIntentFix')}</option>
                          <option value="change">{t('browser.annotateIntentChange')}</option>
                          <option value="question">{t('browser.annotateIntentQuestion')}</option>
                          <option value="approve">{t('browser.annotateIntentApprove')}</option>
                        </select>
                        <select
                          className="annotate-select"
                          title={t('browser.annotatePriorityLabel')}
                          value={a.priority}
                          onChange={(e) =>
                            updateAnnotation(a.id, {
                              priority: e.target.value as PickAnnotationPriority
                            })
                          }
                        >
                          <option value="blocking">{t('browser.annotatePriorityBlocking')}</option>
                          <option value="important">{t('browser.annotatePriorityImportant')}</option>
                          <option value="suggestion">{t('browser.annotatePrioritySuggestion')}</option>
                        </select>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="annotate-panel-footer">
                <button type="button" className="btn" onClick={discardReview}>
                  {t('browser.annotateDiscard')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={pendingAnnotations.length === 0}
                  onClick={() => setConfirmCreateCards(true)}
                >
                  {t('browser.annotateCreateCards')}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={pendingAnnotations.length === 0}
                  onClick={sendReview}
                >
                  {t('browser.annotateSend', { n: pendingAnnotations.length })}
                </button>
              </div>
            </div>
          )}
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
            <label className="record-scenario-label" htmlFor="rec-scenario">
              {t('browser.recordScenario')}
            </label>
            <textarea
              id="rec-scenario"
              className="record-scenario"
              rows={3}
              placeholder={t('browser.recordScenarioPlaceholder')}
              value={recScenario}
              onChange={(e) => setRecScenario(e.target.value)}
            />
            {recScenario.trim() && (
              <div className="record-model">
                <span className="record-scenario-label">{t('browser.recordModel')}</span>
                <ModelPicker
                  catalogs={recCatalogs ?? []}
                  selected={[targetKey(recTarget ?? config.demoTarget)]}
                  multi={false}
                  onlyProviders={['anthropic']}
                  onPick={(_key, target) => setRecTarget(target)}
                />
              </div>
            )}
            <div className="modal-actions">
              <button onClick={() => setRecDialog(false)}>{t('common.cancel')}</button>
              <button className="primary" autoFocus onClick={() => void startFromDialog()}>
                {t(recScenario.trim() ? 'browser.recordStartScenario' : 'browser.recordStart')}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingPick && (
        <PickContextDialog
          pick={pendingPick.pick}
          shot={pendingPick.shot}
          onSend={(note, dontAskAgain) => void sendPendingPick(note, dontAskAgain)}
          onCancel={cancelPendingPick}
          onCreateCard={createPendingPickCard}
        />
      )}
      {confirmCreateCards && (
        <ConfirmDialog
          title={t('browser.annotateCreateCards')}
          message={t('browser.annotateCreateCardsConfirm', { n: pendingAnnotations.length })}
          confirmLabel={t('browser.annotateCreateCards')}
          tone="neutral"
          onCancel={() => setConfirmCreateCards(false)}
          onConfirm={() => {
            setConfirmCreateCards(false)
            void createReviewCards()
          }}
        />
      )}
    </div>
  )
}
