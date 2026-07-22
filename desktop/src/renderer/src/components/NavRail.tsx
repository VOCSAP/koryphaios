import { useEffect, useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { AmphoraGauge, GLYPHS } from './icons'
import { sessionRemainingFraction, usageTone } from '@shared/usage'
import type { DeckView } from '@shared/types'

// Vertical navigation rail (VS Code activity-bar style), left of everything.
// Home = the supervisor session (C5), Agents = the session tiles, Roadmap = C3.
// Icons are the Greek glyph set (icons.tsx / DESIGN.md "Iconography").
const VIEWS: { id: DeckView; key: string }[] = [
  { id: 'home', key: 'nav.home' },
  { id: 'agents', key: 'nav.agents' },
  { id: 'browser', key: 'nav.browser' },
  { id: 'files', key: 'nav.files' },
  { id: 'git', key: 'nav.git' },
  { id: 'roadmap', key: 'nav.roadmap' },
  { id: 'graph', key: 'nav.graph' },
  { id: 'worktrees', key: 'nav.worktrees' },
  { id: 'journal', key: 'nav.journal' }
]

/** Poll cadence of the ± badge (uncommitted-file count, PLAN GX9). */
const GIT_BADGE_POLL_MS = 30_000

/**
 * Poll cadence of the amphora gauge. Slower than the main-side 3-min cache on
 * purpose: every tick refetches for real, and the Anthropic usage endpoint
 * rate-limits sub-3-min polling.
 */
const USAGE_POLL_MS = 5 * 60_000

export function NavRail(): React.JSX.Element {
  const t = useT()
  const view = useDeck((s) => s.view)
  const setView = useDeck((s) => s.setView)

  // VSCode-style change counter on the ± entry: sum of the worktrees' dirty
  // counts (the same numbers the Worktrees view shows). Decorative and
  // best-effort by design: a failure (projectDir not a git repo, transient
  // git error) hides the badge — the Git/Worktrees views surface their own
  // errors when opened.
  const [gitDirty, setGitDirty] = useState(0)
  useEffect(() => {
    let stop = false
    const tick = async (): Promise<void> => {
      try {
        const rows = await window.api.listWorktrees()
        if (!stop) setGitDirty(rows.reduce((n, w) => n + w.dirty, 0))
      } catch {
        if (!stop) setGitDirty(0)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), GIT_BADGE_POLL_MS)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [])
  const inboxOpen = useDeck((s) => s.inboxOpen)
  const inboxUnread = useDeck((s) => s.inboxUnread)
  const openInbox = useDeck((s) => s.openInbox)
  const draftCount = useDeck((s) => s.graphDrafts.length)
  // Attention badge = unread messages + pending drafts; the glyph GLOW is
  // drafts-only (an action is awaited, not just a message to read).
  const badge = inboxUnread + draftCount

  // Residual offline indicator: while the broker is down the inbox entry
  // carries a red dot, so the outage stays visible even once the top banner
  // is dismissed (the dot clears on its own when the broker comes back).
  const brokerStatus = useDeck((s) => s.brokerStatus)

  const remote = useDeck((s) => s.remote)
  const usageOpen = useDeck((s) => s.usageOpen)
  const openUsage = useDeck((s) => s.openUsage)

  // Amphora gauge: remaining session quota averaged over the providers this
  // run draws down (shared/usage.ts). Decorative and best-effort like the git
  // badge: a failed poll falls back to the static glyph, the modal surfaces
  // its own errors when opened.
  const [usageRemaining, setUsageRemaining] = useState<number | null>(null)
  useEffect(() => {
    let stop = false
    const tick = async (): Promise<void> => {
      try {
        const snap = await window.api.usageRead(false)
        if (!stop) setUsageRemaining(sessionRemainingFraction(snap))
      } catch {
        if (!stop) setUsageRemaining(null)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), USAGE_POLL_MS)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [])
  const tone = usageRemaining === null ? null : usageTone(usageRemaining)
  const companionOpen = useDeck((s) => s.companionOpen)
  const openCompanion = useDeck((s) => s.openCompanion)
  const companionRunning = useDeck((s) => s.companionRunning)

  // The embedded browser is a <webview>, Electron-only — hidden for a remote
  // client (EXPLORATION §3); the Compagnon button is a physical-presence
  // action, desktop window only.
  const views = remote ? VIEWS.filter((v) => v.id !== 'browser') : VIEWS

  return (
    <nav className="nav-rail">
      {views.map((v) => (
        <button
          key={v.id}
          className={`nav-rail-item${view === v.id ? ' is-active' : ''}`}
          title={t(v.key)}
          onClick={() => setView(v.id)}
        >
          <span className="nav-rail-icon">
            {GLYPHS[v.id]}
            {v.id === 'git' && gitDirty > 0 && (
              <span className="nav-rail-badge">{gitDirty > 99 ? '99+' : gitDirty}</span>
            )}
          </span>
          <span className="nav-rail-label">{t(v.key)}</span>
        </button>
      ))}
      <div className="nav-rail-spacer" />
      {/* Usage limits (quota gauges of the detected CLIs): overlay modal.
          The amphora's liquid level = mean remaining session quota. */}
      <button
        className={`nav-rail-item${usageOpen ? ' is-active' : ''}${tone ? ` usage-${tone}` : ''}`}
        title={
          usageRemaining === null
            ? t('nav.usage')
            : `${t('nav.usage')} · ${t('usage.remainingTip', {
                pct: `${Math.round(usageRemaining * 100)}`
              })}`
        }
        onClick={() => openUsage(!usageOpen)}
      >
        <span className="nav-rail-icon">
          <AmphoraGauge fraction={usageRemaining} />
        </span>
        <span className="nav-rail-label">{t('nav.usage')}</span>
      </button>
      {!remote && (
        <button
          className={`nav-rail-item${companionOpen ? ' is-active' : ''}${companionRunning ? ' is-glowing' : ''}`}
          title={t('companion.title')}
          onClick={() => openCompanion(!companionOpen)}
        >
          <span className="nav-rail-icon">{GLYPHS.companion}</span>
          <span className="nav-rail-label">{t('companion.title')}</span>
        </button>
      )}
      {/* Operator inbox (PLAN C12): overlay panel, not a view. */}
      <button
        className={`nav-rail-item${inboxOpen ? ' is-active' : ''}${draftCount > 0 ? ' is-glowing' : ''}`}
        title={t('nav.inbox')}
        onClick={() => openInbox(!inboxOpen)}
      >
        <span className="nav-rail-icon">
          {GLYPHS.inbox}
          {badge > 0 && <span className="nav-rail-badge">{badge}</span>}
          {brokerStatus && !brokerStatus.up && (
            <span
              className="nav-rail-offline-dot"
              title={t('banner.brokerDown', {
                time: new Date(brokerStatus.since).toLocaleTimeString()
              })}
            />
          )}
        </span>
        <span className="nav-rail-label">{t('nav.inbox')}</span>
      </button>
    </nav>
  )
}
