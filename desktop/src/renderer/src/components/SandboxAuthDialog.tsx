import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { SANDBOX_AUTH_PTY_ID } from '@shared/types'

// Sandbox first-run login modal (PLAN-SANDBOX SBX3). Flow: intro step
// ("connexion requise") → Next spawns the auth terminal (`claude` inside the
// container, via sandbox:auth-start) → the CLI walks the operator through its
// OAuth login in the embedded xterm → the dialog polls the credentials probe
// and, on success, kills the PTY, closes itself and toasts. Agents cannot
// spawn until this succeeds (the sandboxGate throws 'sandbox-auth-required'),
// so the login prompt appears HERE once — never in every tile.

const PROBE_MS = 2_000

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#1f1f1f', cursor: '#1f1f1f', selectionBackground: '#add6ff' }
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** Dialog-hosted xterm on the auth utility PTY (DockTerminal precedent: no
 * registry registration, no tile chrome). */
function AuthTerminal(): React.JSX.Element {
  const config = useDeck((s) => s.config!)
  const hostRef = useRef<HTMLDivElement>(null)
  const id = SANDBOX_AUTH_PTY_ID

  useEffect(() => {
    const term = new Terminal({
      fontSize: config.fontSize,
      fontFamily: FONT_STACK,
      cursorBlink: true,
      scrollback: 2000,
      theme: THEMES[config.theme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (hostRef.current) term.open(hostRef.current)

    const onInput = term.onData((d) => window.api.ptyInput(id, d))
    const offData = window.api.onPtyData((e) => {
      if (e.id === id) term.write(e.data)
    })
    const offExit = window.api.onPtyExit((e) => {
      if (e.id === id) term.write('\r\n\x1b[2m[terminal closed]\x1b[0m\r\n')
    })
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
        window.api.ptyResize(id, term.cols, term.rows)
      } catch {
        /* mid-teardown */
      }
    })
    return () => {
      cancelAnimationFrame(raf)
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return <div ref={hostRef} className="sandbox-auth-term" />
}

export function SandboxAuthDialog(): React.JSX.Element {
  const t = useT()
  const openSandboxAuth = useDeck((s) => s.openSandboxAuth)
  const refreshSandbox = useDeck((s) => s.refreshSandbox)
  const showToast = useDeck((s) => s.showToast)

  const [step, setStep] = useState<'intro' | 'starting' | 'term'>('intro')
  const [error, setError] = useState<string | null>(null)

  const close = (killPty: boolean): void => {
    if (killPty) void window.api.sandboxAuthStop()
    openSandboxAuth(false)
    void refreshSandbox()
  }

  const start = async (): Promise<void> => {
    setError(null)
    setStep('starting')
    try {
      const ptyId = await window.api.sandboxAuthStart()
      if (ptyId === null) {
        // Volume already carries credentials (e.g. logged in from another
        // project): nothing to do, report success straight away.
        showToast('toast.sandboxAuthDone')
        close(false)
        return
      }
      setStep('term')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStep('intro')
    }
  }

  // Success watcher: poll the credentials probe while the terminal is up.
  useEffect(() => {
    if (step !== 'term') return
    const timer = setInterval(() => {
      void window.api.sandboxAuthProbe().then((authed) => {
        if (authed === true) {
          clearInterval(timer)
          void window.api.sandboxAuthStop()
          showToast('toast.sandboxAuthDone')
          openSandboxAuth(false)
          void refreshSandbox()
        }
      })
    }, PROBE_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  return (
    <div className="modal-backdrop" onMouseDown={() => close(step === 'term')}>
      <div
        className={`modal ${step === 'term' ? 'sandbox-auth-modal' : 'modal-confirm'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{t('sandbox.authDialogTitle')}</h3>
        {step !== 'term' && <p className="sandbox-auth-intro">{t('sandbox.authIntro')}</p>}
        {error && <div className="roadmap-error">{error}</div>}
        {step === 'term' && (
          <>
            <p className="sandbox-auth-hint">{t('sandbox.authWait')}</p>
            <AuthTerminal />
          </>
        )}
        <div className="modal-actions">
          <button onClick={() => close(step === 'term')}>{t('common.cancel')}</button>
          {step !== 'term' && (
            <button className="primary" disabled={step === 'starting'} onClick={() => void start()}>
              {step === 'starting' ? t('sandbox.authStarting') : t('sandbox.authNext')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
