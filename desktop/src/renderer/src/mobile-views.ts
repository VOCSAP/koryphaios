import type { DeckView } from '@shared/types'

// Single source of truth for how each DeckView is surfaced on mobile (PLAN
// MB3, code-review altitude follow-up). Being an EXHAUSTIVE Record<DeckView,…>
// means adding a new DeckView is a COMPILE error until its mobile placement is
// declared here — closing the "shows on desktop, silently missing on mobile"
// gap. `MobileNav` derives its primary tabs and its "More" sheet from this
// table instead of carrying its own hardcoded lists.
//
// Content rendering stays explicit in App.tsx: agents/home are kept mounted
// (xterm scrollback survives), the rest are conditional — an asymmetry a
// generic render table would obscure more than it would help.

export type MobilePlacement =
  /** A bottom-tab-bar primary destination. */
  | 'tab'
  /** Behind the ⋯ "More" sheet. */
  | 'more'
  /** Not reachable on mobile (Electron-only or desktop-first). */
  | 'desktop-only'

export interface MobileViewMeta {
  placement: MobilePlacement
  icon: string
  /** i18n key for the label. */
  labelKey: string
}

export const MOBILE_VIEWS: Record<DeckView, MobileViewMeta> = {
  home: { placement: 'tab', icon: '🏠', labelKey: 'nav.home' },
  agents: { placement: 'tab', icon: '🖥', labelKey: 'nav.agents' },
  roadmap: { placement: 'tab', icon: '🗺', labelKey: 'nav.roadmap' },
  // Read-only diff/file browsing is desktop-first (PLAN GX3/GX6); the
  // DiffPanel modal opened from the Worktrees view stays the mobile diff path.
  files: { placement: 'desktop-only', icon: '📁', labelKey: 'nav.files' },
  git: { placement: 'desktop-only', icon: '±', labelKey: 'nav.git' },
  worktrees: { placement: 'more', icon: '⎇', labelKey: 'nav.worktrees' },
  journal: { placement: 'more', icon: '📜', labelKey: 'nav.journal' },
  // <webview>, Electron-only (EXPLORATION §3): absent from the mobile client.
  browser: { placement: 'desktop-only', icon: '🌐', labelKey: 'nav.browser' },
  // Canvas authoring is desktop-first; the mobile thread mode is deferred (M3e).
  graph: { placement: 'desktop-only', icon: '🕸', labelKey: 'nav.graph' }
}

export const MOBILE_TABS: DeckView[] = (Object.keys(MOBILE_VIEWS) as DeckView[]).filter(
  (v) => MOBILE_VIEWS[v].placement === 'tab'
)

export const MOBILE_MORE: DeckView[] = (Object.keys(MOBILE_VIEWS) as DeckView[]).filter(
  (v) => MOBILE_VIEWS[v].placement === 'more'
)
