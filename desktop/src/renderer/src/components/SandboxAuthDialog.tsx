import { useEffect, useRef, useState } from 'react'
import { errorText, useDeck } from '../store'
import { useT } from '../i18n'
import { SandboxTerminal } from './SandboxTerminal'
import { extractAuthUrl } from '../oauth-url'
import { SANDBOX_AUTH_PTY_ID } from '@shared/types'

// Sandbox first-run login modal (PLAN-SANDBOX SBX3). Flow: intro step
// ("connexion requise") → Next spawns the auth terminal (`claude` inside the
// container, via sandbox:auth-start) → the CLI walks the operator through its
// OAuth login in the embedded xterm → the dialog polls the credentials probe
// and, on success, kills the PTY, closes itself and toasts. Agents cannot
// spawn until this succeeds (the sandboxGate throws 'sandbox-auth-required'),
// so the login prompt appears HERE once — never in every tile.

const PROBE_MS = 2_000
/** Tail of the login stream kept for URL extraction (the CLI repaints a lot). */
const TAIL_CHARS = 16_000

export function SandboxAuthDialog(): React.JSX.Element {
  const t = useT()
  const openSandboxAuth = useDeck((s) => s.openSandboxAuth)
  const refreshSandbox = useDeck((s) => s.refreshSandbox)
  const showToast = useDeck((s) => s.showToast)

  const [step, setStep] = useState<'intro' | 'starting' | 'term'>('intro')
  const [error, setError] = useState<string | null>(null)
  // Sign-in URL lifted out of the login stream (see oauth-url.ts): the buttons
  // it powers are the only reliable way to get it to the host browser.
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const tail = useRef('')

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
      setError(errorText(e))
      setStep('intro')
    }
  }

  // URL watcher: read the same PTY stream the terminal renders, but BEFORE
  // xterm wraps it. A second subscriber is free (the preload multiplexes one
  // ipcRenderer listener per channel).
  useEffect(() => {
    if (step !== 'term') return
    return window.api.onPtyData((e) => {
      if (e.id !== SANDBOX_AUTH_PTY_ID) return
      tail.current = (tail.current + e.data).slice(-TAIL_CHARS)
      const url = extractAuthUrl(tail.current)
      // Ink repaints the whole block, so a mid-write repaint can yield a
      // FRAGMENT of the link we already have. Never trade a complete link for
      // a piece of itself; a genuine retry carries a fresh state and
      // code_challenge, so it is never a substring of the previous one.
      if (url) setAuthUrl((prev) => (prev && prev.includes(url) ? prev : url))
    })
  }, [step])

  // Success watcher: poll the credentials probe while the terminal is up.
  useEffect(() => {
    if (step !== 'term') return
    const timer = setInterval(() => {
      void window.api.sandboxAuthProbe().then((authed) => {
        if (authed !== true) return
        clearInterval(timer)
        void window.api.sandboxAuthStop()
        showToast('toast.sandboxAuthDone')
        openSandboxAuth(false)
        void refreshSandbox()
      })
    }, PROBE_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  return (
    <div className="modal-backdrop" onMouseDown={() => close(step === 'term')}>
      <div
        className={`modal ${step === 'term' ? 'sandbox-term-modal' : 'modal-confirm'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{t('sandbox.authDialogTitle')}</h3>
        {step !== 'term' && <p className="sandbox-auth-intro">{t('sandbox.authIntro')}</p>}
        {error && <div className="roadmap-error">{error}</div>}
        {step === 'term' && (
          <>
            <p className="sandbox-auth-hint">{t('sandbox.authWait')}</p>
            {/* The CLI below runs INSIDE the container and offers its own
                "press c to copy". It writes to the container's clipboard and
                its "Copied!" is therefore a lie on the host -- say so, rather
                than let the operator lose minutes trusting it. */}
            <p className="sandbox-auth-hint">{t('sandbox.authClipboardHint')}</p>
            {authUrl && (
              <div className="sandbox-auth-url">
                <code className="sandbox-auth-url-text">{authUrl}</code>
                {/* The length is here because truncation is this card's known
                    failure mode, and it is otherwise invisible: diagnosing it
                    once meant selecting the terminal by hand and counting. */}
                <span className="sandbox-dim">
                  {t('sandbox.authUrlChars', { n: authUrl.length })}
                </span>
                <div className="sandbox-auth-url-actions">
                  {/* Explicit IPC rather than window.open: main validates the
                      scheme (http/https only) before the OS is asked to launch
                      anything, and a refusal surfaces instead of Windows
                      offering to find an app for `about:`. */}
                  <button
                    className="primary"
                    onClick={() => {
                      window.api.openExternal(authUrl).catch((e: unknown) => setError(errorText(e)))
                    }}
                  >
                    {t('sandbox.authOpenUrl')}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(authUrl)
                      showToast('toast.authUrlCopied')
                    }}
                  >
                    {t('sandbox.authCopyUrl')}
                  </button>
                </div>
              </div>
            )}
            <SandboxTerminal ptyId={SANDBOX_AUTH_PTY_ID} />
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
