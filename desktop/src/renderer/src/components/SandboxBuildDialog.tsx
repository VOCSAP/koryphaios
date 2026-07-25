import { useEffect, useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { SandboxTerminal } from './SandboxTerminal'
import { SANDBOX_BUILD_PTY_ID } from '@shared/types'

// Sandbox image build (PLAN-SANDBOX M2): `docker build` on the shipped
// Dockerfile, run in a utility PTY so the operator reads the real build log
// instead of staring at a spinner. Exit 0 refreshes the status (the "image
// missing" warning clears by itself).

export function SandboxBuildDialog(): React.JSX.Element {
  const t = useT()
  const openSandboxBuild = useDeck((s) => s.openSandboxBuild)
  const refreshSandbox = useDeck((s) => s.refreshSandbox)
  const showToast = useDeck((s) => s.showToast)

  const [started, setStarted] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api
      .sandboxImageBuild()
      .then(() => {
        if (!cancelled) setStarted(true)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const close = (): void => {
    // Leaving mid-build kills the build PTY. Docker never commits an
    // interrupted build, so the image probe stays truthful either way.
    if (done === null) void window.api.sandboxBuildStop()
    openSandboxBuild(false)
    void refreshSandbox(true)
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal sandbox-term-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t('sandbox.buildTitle')}</h3>
        <p className="sandbox-auth-hint">{t('sandbox.buildHint')}</p>
        {error && <div className="roadmap-error">{error}</div>}
        {started && (
          <SandboxTerminal
            ptyId={SANDBOX_BUILD_PTY_ID}
            onExit={(code) => {
              setDone(code)
              if (code === 0) showToast('toast.sandboxImageBuilt')
              void refreshSandbox(true)
            }}
          />
        )}
        <div className="modal-actions">
          <button className={done === 0 ? 'primary' : ''} onClick={close}>
            {done === null ? t('common.cancel') : t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
