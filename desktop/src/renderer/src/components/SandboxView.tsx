import { useCallback, useEffect, useState } from 'react'
import type { SandboxContainerAction, SandboxContainerInfo } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

// Sandbox / Docker view (PLAN-SANDBOX SBX4): the per-project mode toggle, the
// auth-volume card and the cross-project kory-sbx container listing. All
// guards are re-enforced main-side (live sessions, container-name shape) —
// what this view disables is UX, never the security boundary.

const POLL_MS = 10_000

export function SandboxView(): React.JSX.Element {
  const t = useT()
  const status = useDeck((s) => s.sandboxStatus)
  const refreshSandbox = useDeck((s) => s.refreshSandbox)
  const setSandboxEnabled = useDeck((s) => s.setSandboxEnabled)
  const openSandboxAuth = useDeck((s) => s.openSandboxAuth)
  const sessions = useDeck((s) => s.sessions)
  const showToast = useDeck((s) => s.showToast)

  const [containers, setContainers] = useState<SandboxContainerInfo[]>([])
  const [confirmToggle, setConfirmToggle] = useState<boolean | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<SandboxContainerInfo | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)

  const hasLive = sessions.some((s) => s.status === 'running' || s.status === 'starting')

  const refresh = useCallback(async (force?: boolean): Promise<void> => {
    await refreshSandbox(force)
    try {
      setContainers(await window.api.sandboxList())
    } catch {
      setContainers([]) // engine missing/down: the mode card explains why
    }
  }, [refreshSandbox])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const doAction = async (c: SandboxContainerInfo, action: SandboxContainerAction): Promise<void> => {
    setActionBusy(c.name)
    try {
      await window.api.sandboxContainerAction(c.name, action)
      showToast('toast.sandboxAction')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      showToast(
        msg.includes('sandbox-live-sessions') ? t('sandbox.blockedLive') : msg,
        'error',
        { raw: true }
      )
    } finally {
      setActionBusy(null)
      await refresh()
    }
  }

  const engineLine = (): string => {
    if (!status) return '…'
    if (status.engineState === 'ok') {
      return t('sandbox.engineOk', { engine: status.engine ?? '?', version: status.engineVersion ?? '?' })
    }
    if (status.engineState === 'daemon-down') return t('sandbox.engineDown')
    return t('sandbox.engineMissing')
  }

  const stateBadge = (state: string): string => {
    if (state === 'running') return 'rm-badge rm-badge-value-high'
    if (state === 'exited' || state === 'created') return 'rm-badge rm-badge-effort-high'
    return 'rm-badge'
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
              disabled={hasLive || !status || status.engineState !== 'ok'}
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
        {status && (
          <div className="sandbox-line">
            {t('sandbox.container')}{' '}
            <span className="sandbox-mono">{status.containerName}</span>{' '}
            <span className={status.containerState === 'running' ? 'rm-badge rm-badge-value-high' : 'rm-badge'}>
              {t(`sandbox.state.${status.containerState}`)}
            </span>
          </div>
        )}
        {status && (
          <div className="sandbox-line sandbox-dim">
            {t('sandbox.image')} <span className="sandbox-mono">{status.image}</span> ·{' '}
            {t('sandbox.ports')}{' '}
            <span className="sandbox-mono">{status.ports.join(', ') || '—'}</span>
          </div>
        )}
        {hasLive && <div className="sandbox-line sandbox-warn">{t('sandbox.blockedLive')}</div>}
        {status?.error && <div className="roadmap-error">{status.error}</div>}
      </div>

      {/* ---- auth card (the shared volume) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.auth')}</h3>
          <span className="roadmap-spacer" />
          <button
            className="btn"
            disabled={!status || status.engineState !== 'ok'}
            onClick={() => openSandboxAuth(true)}
          >
            {t('sandbox.reauth')}
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
                {c.current && <span className="rm-badge rm-badge-status-in_progress">{t('sandbox.current')}</span>}
                <span className={stateBadge(c.state)}>{c.state || '?'}</span>
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
            void setSandboxEnabled(enable).then(() => refresh())
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
