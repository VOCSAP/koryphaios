import { useCallback, useEffect, useState } from 'react'
import type { SandboxContainerAction, SandboxContainerInfo, SandboxWorkMode } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

// Sandbox / Docker view (PLAN-SANDBOX SBX4 + M2/M3): the per-project mode
// toggle and work mode, the image card (build the shipped Dockerfile), the
// auth-volume card, the operator-config projection report, the broker-bridge
// verdict and the cross-project kory-sbx container listing. All guards are
// re-enforced main-side (live sessions, container-name shape) — what this view
// disables is UX, never the security boundary.

const POLL_MS = 10_000

export function SandboxView(): React.JSX.Element {
  const t = useT()
  const status = useDeck((s) => s.sandboxStatus)
  const refreshSandbox = useDeck((s) => s.refreshSandbox)
  const patchSandbox = useDeck((s) => s.patchSandbox)
  const openSandboxAuth = useDeck((s) => s.openSandboxAuth)
  const openSandboxBuild = useDeck((s) => s.openSandboxBuild)
  const sessions = useDeck((s) => s.sessions)
  const showToast = useDeck((s) => s.showToast)

  const [containers, setContainers] = useState<SandboxContainerInfo[]>([])
  const [confirmToggle, setConfirmToggle] = useState<boolean | null>(null)
  const [confirmMode, setConfirmMode] = useState<SandboxWorkMode | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<SandboxContainerInfo | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [globsDraft, setGlobsDraft] = useState<string | null>(null)
  const [imageDraft, setImageDraft] = useState<string | null>(null)

  const hasLive = sessions.some((s) => s.status === 'running' || s.status === 'starting')
  const engineOk = status?.engineState === 'ok'

  const refresh = useCallback(
    async (force?: boolean): Promise<void> => {
      await refreshSandbox(force)
      try {
        setContainers(await window.api.sandboxList())
      } catch {
        setContainers([]) // engine missing/down: the mode card explains why
      }
    },
    [refreshSandbox]
  )

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const fail = (e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e)
    const key =
      msg.includes('sandbox-live-sessions')
        ? t('sandbox.blockedLive')
        : msg.includes('sandbox-container-running')
          ? t('sandbox.blockedRunning')
          : msg
    showToast(key, 'error', { raw: true })
  }

  const doAction = async (
    c: SandboxContainerInfo,
    action: SandboxContainerAction
  ): Promise<void> => {
    setActionBusy(c.name)
    try {
      await window.api.sandboxContainerAction(c.name, action)
      showToast('toast.sandboxAction')
    } catch (e) {
      fail(e)
    } finally {
      setActionBusy(null)
      await refresh()
    }
  }

  const saveGlobs = async (): Promise<void> => {
    const globs = (globsDraft ?? '')
      .split(/[\n,]/)
      .map((g) => g.trim())
      .filter(Boolean)
    await patchSandbox({ copyIgnored: globs })
    setGlobsDraft(null)
    await refresh()
  }

  const saveImage = async (): Promise<void> => {
    const next = (imageDraft ?? '').trim()
    if (!next) return
    try {
      const st = await window.api.sandboxSetImage(next)
      useDeck.setState({ sandboxStatus: st })
      showToast('toast.sandboxSettingsSaved')
    } catch (e) {
      fail(e)
    } finally {
      setImageDraft(null)
      await refresh(true)
    }
  }

  const disconnect = async (): Promise<void> => {
    try {
      const st = await window.api.sandboxAuthPurge()
      useDeck.setState({ sandboxStatus: st })
      showToast('toast.sandboxDisconnected')
    } catch (e) {
      fail(e)
    }
    await refresh()
  }

  const resetCopy = async (): Promise<void> => {
    try {
      const st = await window.api.sandboxResetCopy()
      useDeck.setState({ sandboxStatus: st })
      showToast('toast.sandboxCopyReset')
    } catch (e) {
      fail(e)
    }
    await refresh()
  }

  const engineLine = (): string => {
    if (!status) return '…'
    if (status.engineState === 'ok') {
      return t('sandbox.engineOk', {
        engine: status.engine ?? '?',
        version: status.engineVersion ?? '?'
      })
    }
    if (status.engineState === 'daemon-down') return t('sandbox.engineDown')
    return t('sandbox.engineMissing')
  }

  return (
    <div className="worktrees-view sandbox-view">
      <header className="worktrees-head">
        <h2>{t('sandbox.title')}</h2>
        <span className="roadmap-spacer" />
        <button className="btn" onClick={() => void refresh(true)}>
          {t('sandbox.refresh')}
        </button>
      </header>

      {/* ---- mode card (this project) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.mode')}</h3>
          <span className="roadmap-spacer" />
          {status?.enabled ? (
            <button
              className="btn danger"
              disabled={hasLive || status.busy}
              onClick={() => setConfirmToggle(false)}
            >
              {t('sandbox.disable')}
            </button>
          ) : (
            <button
              className="primary"
              disabled={hasLive || !engineOk}
              onClick={() => setConfirmToggle(true)}
            >
              {t('sandbox.enable')}
            </button>
          )}
        </div>
        <div className="sandbox-line">{engineLine()}</div>
        {status?.engineState === 'missing' && (
          <div className="sandbox-line sandbox-dim">{t('sandbox.installHint')}</div>
        )}

        {/* work mode: mount the real tree, or an ephemeral clone (M3) */}
        <div className="sandbox-line">
          <span className="sandbox-label">{t('sandbox.workMode')}</span>
          {(['mount', 'copy'] as SandboxWorkMode[]).map((m) => (
            <button
              key={m}
              className={`chip${status?.mode === m ? ' is-active' : ''}`}
              disabled={hasLive || status?.mode === m}
              onClick={() => setConfirmMode(m)}
            >
              {t(`sandbox.workMode.${m}`)}
            </button>
          ))}
        </div>
        <div className="sandbox-line sandbox-dim">
          {t(status?.mode === 'copy' ? 'sandbox.workMode.copyHelp' : 'sandbox.workMode.mountHelp')}
        </div>

        {status && (
          <div className="sandbox-line">
            <span className="sandbox-label">{t('sandbox.container')}</span>
            <span className="sandbox-mono">{status.containerName}</span>
            <span
              className={
                status.containerState === 'running'
                  ? 'rm-badge rm-badge-value-high'
                  : 'rm-badge'
              }
            >
              {t(`sandbox.state.${status.containerState}`)}
            </span>
            {status.driftDays !== null && (
              <span className="rm-badge rm-badge-effort-high" title={t('sandbox.driftHint')}>
                {t('sandbox.drift', { n: status.driftDays })}
              </span>
            )}
          </div>
        )}
        {status && (
          <div className="sandbox-line sandbox-dim">
            <span className="sandbox-label">{t('sandbox.ports')}</span>
            <span className="sandbox-mono">{status.ports.join(', ') || '—'}</span>
          </div>
        )}
        {status && status.containerState === 'running' && (
          <div className="sandbox-line">
            <span className="sandbox-label">{t('sandbox.bridge')}</span>
            {status.brokerBridge === true && (
              <span className="rm-badge rm-badge-value-high">{t('sandbox.bridgeOk')}</span>
            )}
            {status.brokerBridge === false && (
              <span className="rm-badge rm-badge-effort-high">{t('sandbox.bridgeKo')}</span>
            )}
            {status.brokerBridge === null && <span className="rm-badge">{t('sandbox.bridgeUnknown')}</span>}
            <button
              className="btn btn-sm"
              onClick={() => {
                void window.api.sandboxProbeBridge().then(() => refresh())
              }}
            >
              {t('sandbox.bridgeRetest')}
            </button>
          </div>
        )}
        {status?.brokerBridge === false && (
          <div className="sandbox-line sandbox-warn">{t('sandbox.bridgeHint')}</div>
        )}
        {hasLive && <div className="sandbox-line sandbox-warn">{t('sandbox.blockedLive')}</div>}
        {status?.error && <div className="roadmap-error">{status.error}</div>}
      </div>

      {/* ---- ephemeral clone (copy mode only, M3) ---- */}
      {status?.mode === 'copy' && (
        <div className="sandbox-card">
          <div className="sandbox-card-head">
            <h3>{t('sandbox.copy')}</h3>
            <span className="roadmap-spacer" />
            <button className="btn danger" disabled={hasLive} onClick={() => void resetCopy()}>
              {t('sandbox.copyReset')}
            </button>
          </div>
          <div className="sandbox-line sandbox-dim">{t('sandbox.copyHint')}</div>
          <div className="sandbox-line">
            <span className="sandbox-label">{t('sandbox.copyDir')}</span>
            <span className="sandbox-mono">{status.copyDir ?? '—'}</span>
          </div>
          <div className="sandbox-line sandbox-col">
            <span className="sandbox-label">{t('sandbox.copyIgnored')}</span>
            <textarea
              className="sandbox-globs"
              rows={3}
              value={globsDraft ?? status.copyIgnored.join('\n')}
              placeholder={t('sandbox.copyIgnoredPlaceholder')}
              onChange={(e) => setGlobsDraft(e.target.value)}
            />
            <div className="sandbox-line">
              <button className="primary" disabled={globsDraft === null} onClick={() => void saveGlobs()}>
                {t('sandbox.copySaveGlobs')}
              </button>
              {globsDraft !== null && (
                <button className="btn" onClick={() => setGlobsDraft(null)}>
                  {t('common.cancel')}
                </button>
              )}
            </div>
          </div>
          <div className="sandbox-line sandbox-dim">{t('sandbox.copyDenyHint')}</div>
          {status.copyUnmatched.length > 0 && (
            <div className="sandbox-line sandbox-warn">
              {t('sandbox.copyUnmatched', { globs: status.copyUnmatched.join(', ') })}
            </div>
          )}
        </div>
      )}

      {/* ---- image ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.imageCard')}</h3>
          <span className="roadmap-spacer" />
          <button className="btn" disabled={!engineOk || hasLive} onClick={() => openSandboxBuild(true)}>
            {t('sandbox.imageBuild')}
          </button>
        </div>
        <div className="sandbox-line">
          <input
            className="worktrees-branch-input"
            value={imageDraft ?? status?.image ?? ''}
            onChange={(e) => setImageDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveImage()
            }}
          />
          <button className="primary" disabled={imageDraft === null || hasLive} onClick={() => void saveImage()}>
            {t('sandbox.imageSave')}
          </button>
          {status?.imagePresent === true && (
            <span className="rm-badge rm-badge-value-high">{t('sandbox.imageFound')}</span>
          )}
          {status?.imagePresent === false && (
            <span className="rm-badge rm-badge-effort-high">{t('sandbox.imageMissing')}</span>
          )}
        </div>
        {status?.imagePresent === false && (
          <div className="sandbox-line sandbox-warn">{t('sandbox.imageMissingHint')}</div>
        )}
      </div>

      {/* ---- auth card (the shared volume) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.auth')}</h3>
          <span className="roadmap-spacer" />
          <button className="btn" disabled={!engineOk} onClick={() => openSandboxAuth(true)}>
            {t('sandbox.reauth')}
          </button>
          <button
            className="btn danger"
            disabled={!engineOk || status?.authed !== true}
            onClick={() => setConfirmDisconnect(true)}
          >
            {t('sandbox.disconnect')}
          </button>
        </div>
        <div className="sandbox-line">
          {status?.authed === true && (
            <span className="rm-badge rm-badge-value-high">{t('sandbox.authOk')}</span>
          )}
          {status?.authed === false && (
            <span className="rm-badge rm-badge-effort-high">{t('sandbox.authMissing')}</span>
          )}
          {(status?.authed ?? null) === null && (
            <span className="rm-badge">{t('sandbox.authUnknown')}</span>
          )}
        </div>
        <div className="sandbox-line sandbox-dim">{t('sandbox.authVolumeHint')}</div>
      </div>

      {/* ---- operator config projection (M2) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.projection')}</h3>
        </div>
        <div className="sandbox-line">
          <span className="sandbox-mono">{status?.projection || t('sandbox.projectionNone')}</span>
        </div>
        <div className="sandbox-line sandbox-dim">{t('sandbox.projectionHint')}</div>
        {(status?.hookWarnings.length ?? 0) > 0 && (
          <div className="sandbox-line sandbox-col">
            <span className="sandbox-warn">{t('sandbox.hookWarning')}</span>
            {status!.hookWarnings.map((h) => (
              <span key={h} className="sandbox-mono sandbox-dim">
                {h}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ---- containers (all projects) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.containers')}</h3>
        </div>
        {containers.length === 0 && <p className="roadmap-empty">{t('sandbox.empty')}</p>}
        <div className="worktrees-list">
          {containers.map((c) => (
            <div key={c.name} className="wt-row">
              <div className="wt-main">
                <span className="sandbox-mono">{c.name}</span>
                {c.current && (
                  <span className="rm-badge rm-badge-status-in_progress">{t('sandbox.current')}</span>
                )}
                <span
                  className={c.state === 'running' ? 'rm-badge rm-badge-value-high' : 'rm-badge'}
                >
                  {c.state || '?'}
                </span>
              </div>
              <div className="wt-sub" title={c.project}>
                {c.project || '—'} — {c.image}
                {c.age ? ` · ${c.age}` : ''}
              </div>
              <div className="wt-actions">
                {c.state !== 'running' && (
                  <button
                    className="btn"
                    disabled={actionBusy === c.name}
                    onClick={() => void doAction(c, 'start')}
                  >
                    {t('sandbox.start')}
                  </button>
                )}
                {c.state === 'running' && (
                  <button
                    className="btn"
                    disabled={actionBusy === c.name || (c.current && hasLive)}
                    onClick={() => void doAction(c, 'stop')}
                  >
                    {t('sandbox.stop')}
                  </button>
                )}
                {c.current && (
                  <button
                    className="btn"
                    disabled={actionBusy === c.name || hasLive}
                    onClick={() => void doAction(c, 'rebuild')}
                  >
                    {t('sandbox.rebuild')}
                  </button>
                )}
                <button
                  className="btn danger"
                  disabled={actionBusy === c.name || (c.current && hasLive)}
                  onClick={() => setConfirmRemove(c)}
                >
                  {t('sandbox.remove')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirmToggle !== null && (
        <ConfirmDialog
          title={t(confirmToggle ? 'confirm.sandboxOnTitle' : 'confirm.sandboxOffTitle')}
          message={t(confirmToggle ? 'confirm.sandboxOnMessage' : 'confirm.sandboxOffMessage')}
          confirmLabel={t(confirmToggle ? 'confirm.sandboxOnConfirm' : 'confirm.sandboxOffConfirm')}
          onCancel={() => setConfirmToggle(null)}
          onConfirm={() => {
            const enable = confirmToggle
            setConfirmToggle(null)
            void patchSandbox({ enabled: enable }).then(() => refresh())
          }}
        />
      )}

      {confirmMode && (
        <ConfirmDialog
          title={t('confirm.sandboxModeTitle')}
          message={t(
            confirmMode === 'copy' ? 'confirm.sandboxModeCopy' : 'confirm.sandboxModeMount'
          )}
          confirmLabel={t('confirm.sandboxModeConfirm')}
          onCancel={() => setConfirmMode(null)}
          onConfirm={() => {
            const mode = confirmMode
            setConfirmMode(null)
            // The mount source changes ⇒ the container must be recreated.
            void patchSandbox({ mode }).then(async () => {
              const current = containers.find((c) => c.current)
              if (current) await doAction(current, 'rebuild')
              else await refresh()
            })
          }}
        />
      )}

      {confirmDisconnect && (
        <ConfirmDialog
          title={t('confirm.sandboxDisconnectTitle')}
          message={t('confirm.sandboxDisconnectMessage')}
          confirmLabel={t('confirm.sandboxDisconnectConfirm')}
          onCancel={() => setConfirmDisconnect(false)}
          onConfirm={() => {
            setConfirmDisconnect(false)
            void disconnect()
          }}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={t('confirm.sandboxRemoveTitle')}
          message={t('confirm.sandboxRemoveMessage', { name: confirmRemove.name })}
          confirmLabel={t('confirm.sandboxRemoveConfirm')}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const target = confirmRemove
            setConfirmRemove(null)
            void doAction(target, 'remove')
          }}
        />
      )}
    </div>
  )
}
