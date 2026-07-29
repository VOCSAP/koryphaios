import { useEffect, useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { SandboxTerminal } from './SandboxTerminal'
import { SANDBOX_BUILD_PTY_ID } from '@shared/types'

// Sandbox image build (PLAN-SANDBOX M2): `docker build` on the shipped
// Dockerfile, run in a utility PTY so the operator reads the real build log
// instead of staring at a spinner.
//
// The build OUTLIVES this modal: "Hide" puts the log away and lets a
// multi-minute build finish in the background (the Image card grows a spinner
// and a "Show log" button). The dialog is therefore a VIEW on a build owned by
// the store -- it neither spawns on mount if one is already running, nor kills
// on unmount. Only the explicit Cancel stops the PTY, and only the app-level
// exit watcher decides what a finished build means.

export function SandboxBuildDialog(): React.JSX.Element {
  const t = useT()
  const openSandboxBuild = useDeck((s) => s.openSandboxBuild)
  const startSandboxBuild = useDeck((s) => s.startSandboxBuild)
  const refreshSandbox = useDeck((s) => s.refreshSandbox)
  const building = useDeck((s) => s.sandboxBuilding)

  // Once the terminal is up it STAYS up, even after the build exits: the log
  // of a build that just failed is exactly what the operator opened this for.
  const [attached, setAttached] = useState(false)
  useEffect(() => {
    if (building) setAttached(true)
  }, [building])

  // Reopening the modal on a running build must NOT start a second one;
  // startSandboxBuild is a no-op while one is alive.
  useEffect(() => {
    void startSandboxBuild(useDeck.getState().sandboxAuthAfterBuild)
  }, [startSandboxBuild])

  /** Put the log away, keep building. */
  const hide = (): void => openSandboxBuild(false)

  /** Stop the build for good. Docker never commits an interrupted build, so
      the image probe stays truthful either way. */
  const cancel = (): void => {
    void window.api.sandboxBuildStop()
    openSandboxBuild(false)
    void refreshSandbox(true)
  }

  return (
    <div className="modal-backdrop" onMouseDown={hide}>
      <div className="modal sandbox-term-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t('sandbox.buildTitle')}</h3>
        <p className="sandbox-auth-hint">{t('sandbox.buildHint')}</p>
        {attached && <SandboxTerminal ptyId={SANDBOX_BUILD_PTY_ID} />}
        <div className="modal-actions">
          {building && <button onClick={cancel}>{t('common.cancel')}</button>}
          <button className="primary" onClick={hide}>
            {building ? t('sandbox.buildHide') : t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
