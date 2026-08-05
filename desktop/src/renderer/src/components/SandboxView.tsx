import { useCallback, useEffect, useState } from 'react'
import type { SandboxContainerAction, SandboxContainerInfo, SandboxWorkMode } from '@shared/types'
import { SANDBOX_IMAGE_CUSTOM_TAG, SANDBOX_IMAGE_DEFAULT_TAG, isUnboundedGlob } from '@shared/types'
import { errorText, useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { GLYPH_ACTIONS } from './icons'

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
  const startSandboxBuild = useDeck((s) => s.startSandboxBuild)
  const building = useDeck((s) => s.sandboxBuilding)
  const sessions = useDeck((s) => s.sessions)
  const removeSession = useDeck((s) => s.removeSession)
  const showToast = useDeck((s) => s.showToast)
  // Store-cached (null = never fetched): the view is unmounted on navigation,
  // so component state would flash "no containers" on every visit while the
  // engine answers.
  const containers = useDeck((s) => s.sandboxContainers)
  const refreshSandboxContainers = useDeck((s) => s.refreshSandboxContainers)
  const [confirmToggle, setConfirmToggle] = useState<boolean | null>(null)
  const [confirmMode, setConfirmMode] = useState<SandboxWorkMode | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<SandboxContainerInfo | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmForceClose, setConfirmForceClose] = useState(false)
  const [confirmImageRemove, setConfirmImageRemove] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [globsDraft, setGlobsDraft] = useState<string | null>(null)
  // Client-side mirror of writeSandboxSettings' write-path rejection (card
  // 4b668844): caught here so the refusal is immediate and localized instead
  // of round-tripping through the generic `sandbox settings failed: ...`
  // toast — main still re-checks on save as the fail-closed backstop.
  const [globsError, setGlobsError] = useState<string | null>(null)
  const [portsDraft, setPortsDraft] = useState<string | null>(null)
  const [imageDraft, setImageDraft] = useState<string | null>(null)
  // Custom image fragment (f29b1917): saved copy + unsaved draft, same
  // draft-or-saved pattern as the fields above.
  const [customSaved, setCustomSaved] = useState('')
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [confirmOverlay, setConfirmOverlay] = useState(false)
  const [confirmProjectionRemove, setConfirmProjectionRemove] = useState(false)

  // Every live session pins the sandbox settings — the supervisor included, so
  // the operator needs a way to clear them without hunting them down by hand.
  const liveSessions = sessions.filter((s) => s.status === 'running' || s.status === 'starting')
  const hasLive = liveSessions.length > 0
  const engineOk = status?.engineState === 'ok'
  // Re-authenticating spawns `claude` INSIDE the container, so it needs the
  // image: without this guard the button throws an opaque "image not found".
  const imageReady = status?.imagePresent === true
  // The generated overlay file specifically (status.overlay may also carry
  // hand-placed agents/ etc.): drives the Generate/Regenerate button state.
  const overlayExists = status?.overlay.includes('settings.json') === true
  // Container pre-flight in progress, main-side (ensure(): create + start +
  // projection). Drives the Préparer spinner/disable.
  const sandboxBusy = status?.busy === true
  // Operator opt-out of the config projection ("Remove"); Generate re-enables.
  const projectionOn = status?.projectionEnabled !== false

  const refresh = useCallback(
    async (force?: boolean): Promise<void> => {
      // Parallel on purpose: the status probes (engine, image, auth) can take
      // seconds on a cold Docker Desktop, and `docker ps` does not depend on
      // any of them -- serializing left the list looking empty meanwhile.
      await Promise.all([refreshSandbox(force), refreshSandboxContainers()])
    },
    [refreshSandbox, refreshSandboxContainers]
  )

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    window.api
      .sandboxCustomGet()
      .then(setCustomSaved)
      .catch((e: unknown) =>
        window.api.reportError('sandbox', `custom fragment read failed: ${errorText(e)}`)
      )
  }, [])

  const fail = (e: unknown): void => {
    const msg = errorText(e)
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
    const unbounded = globs.filter(isUnboundedGlob)
    if (unbounded.length > 0) {
      setGlobsError(t('sandbox.copyIgnoredUnbounded', { globs: unbounded.join(', ') }))
      return
    }
    setGlobsError(null)
    await patchSandbox({ copyIgnored: globs })
    setGlobsDraft(null)
    await refresh()
  }

  const savePorts = async (): Promise<void> => {
    // An empty field is meaningful: "publish nothing", which is how a second
    // project avoids colliding with the first on the shared defaults.
    const ports = (portsDraft ?? '')
      .split(/[\s,]+/)
      .map((p) => Number.parseInt(p, 10))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
    await patchSandbox({ ports })
    setPortsDraft(null)
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

  const saveCustom = async (): Promise<string> => {
    const next = customDraft ?? customSaved
    if (customDraft !== null) {
      await window.api.sandboxCustomSave(customDraft)
      setCustomSaved(customDraft)
      setCustomDraft(null)
    }
    return next
  }

  const buildCustom = async (): Promise<void> => {
    try {
      // An unsaved draft is what the operator SEES — building the older saved
      // copy instead would be the classic editor/runtime mismatch.
      const fragment = await saveCustom()
      if (!fragment.trim()) return
      await startSandboxBuild(false, true)
    } catch (e) {
      fail(e)
    }
  }

  const useCustomImage = async (): Promise<void> => {
    try {
      const st = await window.api.sandboxSetImage(SANDBOX_IMAGE_CUSTOM_TAG)
      useDeck.setState({ sandboxStatus: st })
      showToast('toast.sandboxSettingsSaved')
      await refresh(true)
    } catch (e) {
      fail(e)
    }
  }

  // Projection opt-out: persists projectConfig=false and scrubs the container
  // (running now, or at its next start). Confirmed first -- it strips the
  // agents' CLAUDE.md/agents/skills/plugins/settings inside the sandbox.
  const removeProjection = async (): Promise<void> => {
    try {
      const st = await window.api.sandboxProjectionRemove()
      useDeck.setState({ sandboxStatus: st })
      showToast('toast.sandboxProjectionRemoved')
    } catch (e) {
      fail(e)
    }
  }

  const generateOverlay = async (force: boolean): Promise<void> => {
    try {
      const res = await window.api.sandboxOverlayGenerate(force)
      setConfirmOverlay(false)
      showToast(t('toast.sandboxOverlayDone', { n: res.removed.length }), 'info', { raw: true })
      await refresh(true)
    } catch (e) {
      // First attempt refuses to overwrite a hand-tuned overlay; the dialog
      // makes the overwrite an explicit operator decision.
      if (errorText(e).includes('overlay-exists')) setConfirmOverlay(true)
      else fail(e)
    }
  }

  // One row per container, shared by the project card and the all-projects
  // list so their controls can never drift apart.
  const containerRow = (c: SandboxContainerInfo): React.JSX.Element => (
    <div key={c.name} className="wt-row">
      <div className="wt-main">
        <span className="sandbox-mono">{c.name}</span>
        {c.current && (
          <span className="rm-badge rm-badge-status-in_progress">{t('sandbox.current')}</span>
        )}
        <span className={c.state === 'running' ? 'rm-badge rm-badge-value-high' : 'rm-badge'}>
          {c.state || '?'}
        </span>
      </div>
      <div className="wt-sub" title={c.project}>
        {c.project || '—'} — {c.image}
        {c.age ? ` · ${c.age}` : ''}
      </div>
      <div className="wt-actions">
        {/* Colour follows DESIGN §2: blue = the affirmative action of
            the row, orange = restoration (a rebuild recreates the
            container), red = destroy. Stop stays neutral.
            While the IMAGE is building, start/rebuild/remove are
            disabled: they act on an image mid-replacement (and the row
            can describe a container that does not exist yet). Stop
            stays live — halting a running container never needs the
            image. */}
        {c.state !== 'running' && (
          <button
            className="primary"
            disabled={actionBusy === c.name || building}
            onClick={() => void doAction(c, 'start')}
          >
            {t('sandbox.start')}
          </button>
        )}
        {c.state === 'running' && (
          <button
            className="btn btn-halt"
            disabled={actionBusy === c.name || (c.current && hasLive)}
            onClick={() => void doAction(c, 'stop')}
          >
            {t('sandbox.stop')}
          </button>
        )}
        {c.current && (
          <button
            className="btn btn-restore"
            disabled={actionBusy === c.name || hasLive || building}
            onClick={() => void doAction(c, 'rebuild')}
          >
            {t('sandbox.rebuild')}
          </button>
        )}
        <button
          className="btn danger"
          disabled={actionBusy === c.name || (c.current && hasLive) || building}
          onClick={() => setConfirmRemove(c)}
        >
          {t('sandbox.remove')}
        </button>
      </div>
    </div>
  )

  // Quick warm-up from the project card: creates/starts the container and
  // projects the config in the background (main-side fire-and-forget).
  //
  // `preparing` covers the click-to-busy gap: the IPC returns immediately
  // (fire-and-forget), and status.busy only flips once ensure() actually
  // starts -- without the local flag the button stayed clickable for a beat
  // and invited double-clicks.
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    // Main took over: status.busy now drives the spinner/disable.
    if (sandboxBusy) setPreparing(false)
  }, [sandboxBusy])
  useEffect(() => {
    // Safety valve for the degenerate early-outs (image removed under us,
    // mode raced off): warmUp() then never sets busy, so never stick.
    if (!preparing) return
    const timer = setTimeout(() => setPreparing(false), 15000)
    return () => clearTimeout(timer)
  }, [preparing])
  const prepareContainer = async (): Promise<void> => {
    setPreparing(true)
    try {
      await window.api.sandboxWarmUp()
      showToast('toast.sandboxPreparing')
    } catch (e) {
      setPreparing(false)
      fail(e)
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

  // Close every live session so the sandbox toggles unlock. Iterates a SNAPSHOT
  // of the ids: removeSession mutates the store list we would otherwise be
  // walking. Errors are already reported by the store's guarded() wrapper.
  const forceClose = async (): Promise<void> => {
    const ids = liveSessions.map((s) => s.id)
    for (const id of ids) await removeSession(id)
    await refresh()
  }

  const removeImage = async (): Promise<void> => {
    try {
      const st = await window.api.sandboxImageRemove()
      useDeck.setState({ sandboxStatus: st })
      showToast('toast.sandboxImageRemoved')
    } catch (e) {
      fail(e)
    }
    // Refresh whatever the outcome: on a refusal the badge must keep telling
    // the truth (the image is still there), not stay on a stale verdict.
    await refresh(true)
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
          <div className="sandbox-line">
            <span className="sandbox-label">{t('sandbox.ports')}</span>
            <input
              className="worktrees-branch-input"
              value={portsDraft ?? status.ports.join(', ')}
              placeholder={t('sandbox.portsPlaceholder')}
              disabled={hasLive}
              onChange={(e) => setPortsDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void savePorts()
              }}
            />
            <button
              className="primary"
              disabled={portsDraft === null || hasLive}
              onClick={() => void savePorts()}
            >
              {t('sandbox.portsSave')}
            </button>
          </div>
        )}
        {status && <div className="sandbox-line sandbox-dim">{t('sandbox.portsHint')}</div>}
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
        {hasLive && (
          <div className="sandbox-line">
            <span className="sandbox-warn">{t('sandbox.blockedLive')}</span>
            <button className="btn danger" onClick={() => setConfirmForceClose(true)}>
              {t('sandbox.forceClose', { n: liveSessions.length })}
            </button>
          </div>
        )}
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
              onChange={(e) => {
                setGlobsDraft(e.target.value)
                setGlobsError(null)
              }}
            />
            <div className="sandbox-line">
              <button className="primary" disabled={globsDraft === null} onClick={() => void saveGlobs()}>
                {t('sandbox.copySaveGlobs')}
              </button>
              {globsDraft !== null && (
                <button
                  className="btn"
                  onClick={() => {
                    setGlobsDraft(null)
                    setGlobsError(null)
                  }}
                >
                  {t('common.cancel')}
                </button>
              )}
            </div>
            {globsError && <div className="sandbox-line sandbox-warn">{globsError}</div>}
          </div>
          <div className="sandbox-line sandbox-dim">{t('sandbox.copyDenyHint')}</div>
          {status.copyUnmatched.length > 0 && (
            <div className="sandbox-line sandbox-warn">
              {t('sandbox.copyUnmatched', { globs: status.copyUnmatched.join(', ') })}
            </div>
          )}
          {status.denied.length > 0 && (
            <div className="sandbox-line sandbox-warn">
              {t('sandbox.copyDenied', { n: status.denied.length })}
            </div>
          )}
        </div>
      )}

      {/* ---- this project's container (2a): quick start/stop without
          scrolling down to the all-projects list. Always shown, sandbox mode
          on or off: disabling the mode KEEPS the container (that is what the
          off-confirm dialog promises), so this card is where it stays
          manageable. Only "Préparer" needs the mode on (warmUp() no-ops when
          disabled). ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.containerProject')}</h3>
          <span className="roadmap-spacer" />
          {status?.enabled === true && (containers ?? []).every((c) => !c.current) && (
            <>
              {/* Same archetype as the Image card's build state: spinner
                  beside the (disabled) button while the pre-flight runs. */}
              {(preparing || sandboxBusy) && (
                <span className="sandbox-spinner" title={t('toast.sandboxPreparing')}>
                  {GLYPH_ACTIONS.refresh}
                </span>
              )}
              <button
                className="primary"
                disabled={!engineOk || !imageReady || building || preparing || sandboxBusy}
                onClick={() => void prepareContainer()}
              >
                {t('sandbox.containerPrepare')}
              </button>
            </>
          )}
        </div>
        {containers === null ? (
          <div className="sandbox-line sandbox-dim">{t('sandbox.containersLoading')}</div>
        ) : containers.filter((c) => c.current).length === 0 ? (
          <div className="sandbox-line sandbox-dim">
            {status?.enabled === true
              ? t('sandbox.containerProjectNone')
              : t('sandbox.containerProjectDisabled')}
          </div>
        ) : (
          <div className="worktrees-list">{containers.filter((c) => c.current).map(containerRow)}</div>
        )}
      </div>

      {/* ---- image ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.imageCard')}</h3>
          <span className="roadmap-spacer" />
          {/* One slot, two states: build (blue, the affirmative action) while
              the image is missing, remove (red) once it exists. Removing the
              CONTAINER never removes the image -- they are separate Docker
              objects -- so without this the "present" badge looked stuck. */}
          {building ? (
            <>
              <span className="sandbox-spinner" title={t('sandbox.building')}>
                {GLYPH_ACTIONS.refresh}
              </span>
              <button className="btn" onClick={() => openSandboxBuild(true)}>
                {t('sandbox.buildShowLog')}
              </button>
            </>
          ) : imageReady ? (
            <button
              className="btn danger"
              disabled={!engineOk || hasLive}
              onClick={() => setConfirmImageRemove(true)}
            >
              {t('sandbox.imageRemove')}
            </button>
          ) : (
            <button
              className="primary"
              disabled={!engineOk || hasLive}
              onClick={() => void startSandboxBuild(false)}
            >
              {t('sandbox.imageBuild')}
            </button>
          )}
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

      {/* ---- custom image (f29b1917) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.customCard')}</h3>
          <span className="roadmap-spacer" />
          <button
            className="btn"
            disabled={customDraft === null}
            onClick={() => void saveCustom().catch(fail)}
          >
            {t('sandbox.customSave')}
          </button>
          <button
            className="primary"
            disabled={!engineOk || building || !(customDraft ?? customSaved).trim()}
            onClick={() => void buildCustom()}
          >
            {t('sandbox.customBuild')}
          </button>
        </div>
        <div className="sandbox-line sandbox-dim">{t('sandbox.customHint')}</div>
        <textarea
          className="sandbox-custom-editor"
          rows={6}
          spellCheck={false}
          placeholder={t('sandbox.customPlaceholder')}
          value={customDraft ?? customSaved}
          onChange={(e) => setCustomDraft(e.target.value)}
        />
        <div className="sandbox-line">
          <span className="sandbox-mono sandbox-dim">
            FROM {SANDBOX_IMAGE_DEFAULT_TAG} → {SANDBOX_IMAGE_CUSTOM_TAG}
          </span>
          <span className="roadmap-spacer" />
          {status?.image !== SANDBOX_IMAGE_CUSTOM_TAG && (
            <button className="btn" disabled={hasLive} onClick={() => void useCustomImage()}>
              {t('sandbox.customUse')}
            </button>
          )}
        </div>
      </div>

      {/* ---- auth card (the shared volume) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.auth')}</h3>
          <span className="roadmap-spacer" />
          {/* The image carries the CLI, so signing in genuinely needs it -- but
              that is OUR problem to solve, not a dead end to hand the operator:
              with no image, this builds it first and opens the login when the
              build succeeds (store.finishSandboxBuild). */}
          <button
            className="primary"
            disabled={!engineOk || building}
            onClick={() => (imageReady ? openSandboxAuth(true) : void startSandboxBuild(true))}
          >
            {imageReady ? t('sandbox.reauth') : t('sandbox.reauthBuildFirst')}
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
        {engineOk && !imageReady && !building && (
          <div className="sandbox-line sandbox-dim">{t('sandbox.reauthBlocked')}</div>
        )}
        <div className="sandbox-line sandbox-dim">{t('sandbox.authVolumeHint')}</div>
      </div>

      {/* ---- operator config projection (M2) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.projection')}</h3>
          <span className="roadmap-spacer" />
          {/* Overlay generation (50ac8683): host settings minus host-only
              hooks. Blue while nothing exists (the affirmative action);
              orange "Regenerate" once the overlay is there (DESIGN.md §2:
              orange = replace/restore). With an existing overlay the confirm
              dialog opens DIRECTLY: probing via a non-force IPC call was
              guaranteed to reject with overlay-exists and spammed the console
              with "Error occurred in handler" on every click. The
              overlay-exists catch in generateOverlay stays as the race
              fallback (file created between status refresh and click). */}
          <button
            className={overlayExists ? 'btn btn-restore' : 'primary'}
            onClick={() => (overlayExists ? setConfirmOverlay(true) : void generateOverlay(false))}
          >
            {t(overlayExists ? 'sandbox.overlayRegenerate' : 'sandbox.overlayGenerate')}
          </button>
          {/* Red opt-out AFTER the generate action (destructive last): stop
              carrying the global config into the container at all. Hidden
              once off (the generate button is then the way back in).
              Disabled while agents run -- they are USING that config. */}
          {projectionOn && (
            <button
              className="btn danger"
              disabled={hasLive}
              title={hasLive ? t('sandbox.blockedRunning') : undefined}
              onClick={() => setConfirmProjectionRemove(true)}
            >
              {t('sandbox.projectionRemove')}
            </button>
          )}
        </div>
        {/* Two DISTINCT states, two lines: the overlay is host-side and moves
            the moment "Generate" writes it; the projection only moves at the
            next container start. One unlabelled line conflated them and the
            card kept saying "nothing projected" right after a generate. */}
        <div className="sandbox-line">
          <span className="sandbox-mono">
            {(status?.overlay.length ?? 0) > 0
              ? t('sandbox.overlayPresent', { files: status!.overlay.join(', ') })
              : t('sandbox.overlayNone')}
          </span>
        </div>
        <div className="sandbox-line">
          <span className="sandbox-mono">
            {projectionOn
              ? status?.projection || t('sandbox.projectionNone')
              : t('sandbox.projectionDisabledLine')}
          </span>
        </div>
        <div className="sandbox-line sandbox-dim">{t('sandbox.projectionHint')}</div>
        {/* Isolation limits (0da2bf11): a design statement, not a warning —
            what a sandboxed session shares with the host and what it never
            will. Stated here so the gap is product copy, not a surprise in an
            agent's terminal. */}
        <div className="sandbox-line sandbox-dim">{t('sandbox.isolationNote')}</div>
        {(status?.hookWarnings.length ?? 0) > 0 && (
          <div className="sandbox-line sandbox-col">
            <span className="sandbox-warn">{t('sandbox.hookWarning')}</span>
            {status!.hookWarnings.map((h) => (
              <span key={h} className="sandbox-mono sandbox-dim">
                {h}
              </span>
            ))}
            <span className="sandbox-dim">{t('sandbox.hookWarningRemedy')}</span>
          </div>
        )}
      </div>

      {/* ---- containers (all projects) ---- */}
      <div className="sandbox-card">
        <div className="sandbox-card-head">
          <h3>{t('sandbox.containers')}</h3>
        </div>
        {containers === null ? (
          // Distinct from "empty": the engine has not answered yet. Claiming
          // "no containers" during the first `docker ps` is the lie this
          // placeholder exists to avoid.
          <p className="roadmap-empty">{t('sandbox.containersLoading')}</p>
        ) : (
          <>
            {containers.length === 0 && <p className="roadmap-empty">{t('sandbox.empty')}</p>}
            <div className="worktrees-list">{containers.map(containerRow)}</div>
          </>
        )}
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
              const current = (containers ?? []).find((c) => c.current)
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
      {confirmOverlay && (
        <ConfirmDialog
          title={t('confirm.sandboxOverlayTitle')}
          message={t('confirm.sandboxOverlayMessage')}
          confirmLabel={t('confirm.sandboxOverlayConfirm')}
          onCancel={() => setConfirmOverlay(false)}
          onConfirm={() => void generateOverlay(true)}
        />
      )}
      {confirmProjectionRemove && (
        <ConfirmDialog
          title={t('confirm.sandboxProjectionRemoveTitle')}
          message={t('confirm.sandboxProjectionRemoveMessage')}
          confirmLabel={t('confirm.sandboxProjectionRemoveConfirm')}
          onCancel={() => setConfirmProjectionRemove(false)}
          onConfirm={() => {
            setConfirmProjectionRemove(false)
            void removeProjection()
          }}
        />
      )}

      {confirmImageRemove && (
        <ConfirmDialog
          title={t('confirm.sandboxImageRemoveTitle')}
          message={t('confirm.sandboxImageRemoveMessage')}
          confirmLabel={t('confirm.sandboxImageRemoveConfirm')}
          onCancel={() => setConfirmImageRemove(false)}
          onConfirm={() => {
            setConfirmImageRemove(false)
            void removeImage()
          }}
        />
      )}

      {confirmForceClose && (
        <ConfirmDialog
          title={t('confirm.sandboxForceCloseTitle')}
          message={t('confirm.sandboxForceCloseMessage', { n: liveSessions.length })}
          confirmLabel={t('confirm.sandboxForceCloseConfirm')}
          onCancel={() => setConfirmForceClose(false)}
          onConfirm={() => {
            setConfirmForceClose(false)
            void forceClose()
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
