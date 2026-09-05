import { create } from 'zustand'
import { inboxEntryKey } from '@shared/types'
import type {
  AckableInboxEntry,
  AppConfig,
  BrokerStatusEvent,
  CreateSessionInput,
  DeckGraphDraft,
  DeckView,
  HelpSelection,
  InboxAckStatus,
  InboxEntry,
  InboxMessage,
  LocaleOption,
  PeersConfigSummary,
  RoadmapKind,
  RoadmapSyncEvent,
  RoadmapSyncResolution,
  SandboxContainerInfo,
  SandboxSettingsPatch,
  SandboxStatus,
  SessionRuntime,
  TemplateSummary,
  WorkspaceSummary
} from '@shared/types'
import { onRemoteRefresh, onRemoteState, remoteInstalled, type RemoteState } from './remote-api'
import { shouldShowTemplateAppliedToast } from '@shared/template-apply-outcome'
import { workspaceRestoreToastKeyFor } from '@shared/workspace-restore-outcome'

/**
 * The blocking-question payload, DERIVED from the Courrier union instead of
 * re-imported: `Approval` is a repo-root wire type that `@shared/types` pulls
 * in for its own declaration but does not re-export. Deriving it keeps a
 * single source of truth — a change to the union's third arm lands here as a
 * type error, never as a silently diverging local mirror.
 */
export type InboxApproval = Extract<InboxEntry, { kind: 'approval' }>['approval']

interface DeckState {
  sessions: SessionRuntime[]
  config: AppConfig | null
  /** Active navigation-rail view: agents (sessions) or roadmap. */
  view: DeckView
  /** Active translation dict (flat key->template), fetched from main. */
  dict: Record<string, string>
  /** Languages offered in Settings, derived from the present locale files. */
  availableLocales: LocaleOption[]
  selectedId: string | null
  maximizedId: string | null
  /** Cross-session search panel visibility (Ctrl+Shift+F / modebar toggle). */
  searchOpen: boolean
  settingsOpen: boolean
  workspacesOpen: boolean
  /** Workspaces window opened in load-only mode (startup arrow): hides Delete. */
  workspacesLoadOnly: boolean
  /** "New (clear)" confirm dialog visibility (triggered by the File menu). */
  confirmNewClearOpen: boolean
  /** Save As prompt window visibility. */
  saveAsOpen: boolean
  /** Template picker (import) visibility. */
  templatesOpen: boolean
  /** Picker opened in manage mode (File > Import template): shows per-row Delete. */
  templatesManage: boolean
  /**
   * Bumped by openTemplates(open, { composer: true }), consumed and cleared by
   * TemplatesDialog once it opens, and forced back to 0 unconditionally on
   * close.
   * Self-clearing so closing the dialog and reopening it later via an unrelated
   * path never resurrects a stale request.
   * A counter rather than a boolean only matters for two requests landing in
   * the same React batch, where a second true before the first clear flushes
   * would otherwise collapse to one edge.
   */
  templatesComposerSeed: number
  /** Export-template dialog (name + local checkbox) visibility. */
  exportTemplateOpen: boolean
  /** Discovered templates (global + local), refreshed when the picker opens. */
  templates: TemplateSummary[]
  /** Workspace id pending a restore confirm (loss warning), or null. */
  restoreLossId: string | null
  /** Transient toast message (an i18n key, or raw text when toastRaw). */
  toast: string | null
  /** Toast colour variant. */
  toastVariant: 'success' | 'info' | 'error'
  /** True when `toast` is raw text (an error message), not an i18n key. */
  toastRaw: boolean
  /** Name of the current workspace, shown in the window title. */
  currentWorkspaceName: string | null
  workspaces: WorkspaceSummary[]
  /** Live sidebar width (px); seeded from config, persisted on drag end. */
  sidebarWidth: number
  /** Agents sidebar folded to its rail; seeded from config, persisted on toggle. */
  sidebarCollapsed: boolean
  /** Roadmap filter panel folded to its rail; same lifecycle as the one above. */
  roadmapFiltersCollapsed: boolean
  /** Graph chats panel folded to its rail; same lifecycle as the one above. */
  graphListCollapsed: boolean
  /** Whether picking an element in the browser's inspect mode opens the pick-context dialog; seeded from config, persisted on toggle. */
  pickContextPrompt: boolean
  /** Operator inbox (PLAN C12): drained agent messages, newest LAST. */
  inboxMessages: InboxMessage[]
  inboxOpen: boolean
  /**
   * Family-3 Courrier entries: blocking questions an agent is STOPPED on,
   * pushed whole by 'approvals:pending' (a full list, not a delta). Held in
   * the store and not locally in the panel because the rail badge must count
   * them even while the panel is closed — the one family where someone waits.
   */
  pendingApprovals: InboxApproval[]
  /**
   * Durable read-state of the family 1/2 entries, keyed by `inboxEntryKey()`.
   * An ABSENT key is the third state ('unread') and is never written.
   */
  inboxAckState: Record<string, InboxAckStatus>
  /**
   * Reply drafts in flight, keyed by the same entry key. Lives in the store
   * and not in the panel: `InboxPanel` is unmounted when the Courrier is
   * folded, so a component-local draft would be destroyed by an accidental
   * close — the operator would lose what they typed.
   */
  inboxReplyDrafts: Record<string, string>
  /** Pending graph drafts (agent-escalated questions): drive the rail glyph. */
  graphDrafts: DeckGraphDraft[]
  /**
   * Offline replica: replication health + this project's conflicts, pushed
   * whole by 'roadmap:sync'. Held in the store and not in the roadmap view
   * because the rail badge and the offline banner must be truthful while the
   * operator is looking at another view entirely.
   */
  roadmapSync: RoadmapSyncEvent
  /**
   * Summary of the claude-peers CORE config (Settings > Broker), null until
   * the panel asks for it. Read lazily rather than at boot: it is one file
   * read serving one settings category, and it must be re-read on open
   * because the operator can edit that file outside the Deck.
   */
  peersConfig: PeersConfigSummary | null
  /**
   * The last read of that summary FAILED. Distinct from `peersConfig === null`,
   * which is also the never-read-yet state: the panel must show an explicit
   * error instead of an empty page, and a blank page is what a single null
   * would give it.
   */
  peersConfigError: boolean
  /**
   * Id of the conflicted card whose resolution dialog is open, null when
   * closed. Store-owned rather than a prop chain: the same dialog is opened
   * from the kanban card, from the mobile list and from the detail modal.
   */
  roadmapConflictId: string | null
  /** Graph view navigation request: open this doc and select this node. */
  graphFocus: { docId: string; nodeId: string } | null
  /** Diff panel target (PLAN C13): a dir to diff + display title, or null. */
  diffTarget: { dir: string; title: string } | null
  /**
   * Pending help-assistant seed (PLAN GX7): a prefilled question + the code
   * selection it is about, set by the Files view. The HelpAssistant consumes
   * it (opens, prefills, attaches) then clears it; sending stays manual.
   */
  helpSeed: { question: string; selection: HelpSelection } | null
  /**
   * Pending roadmap-editor seed (PLAN GX8): prefill for the create form, set
   * by the Files view ("create a task on this code"). RoadmapView consumes it
   * when it mounts/sees it; saving stays an explicit operator action.
   */
  roadmapSeed: { title: string; kind: RoadmapKind; description: string } | null
  /**
   * Embedded browser (PLAN D1): session docked next to the browser pane, or
   * null for a full-width browser. Set by the tile's 🌐 button.
   */
  browserPairedId: string | null
  /**
   * True once the browser view has been opened at least this run: the webview
   * mounts lazily (no dev-server hit at startup) then stays alive, same
   * keep-mounted pattern as the agents/home views.
   */
  browserOpened: boolean
  /**
   * Epoch ms when the REC screen recording started, null when idle. Owned by
   * BrowserView (which stays mounted); mirrored here so the nav rail can show
   * a recording indicator while the operator visits other views.
   */
  recordingSince: number | null
  /** Boot failure message (PLAN O4): init() rejected, splash shows a retry. */
  initError: string | null
  /** Broker reachability (PLAN O5): null until main reports, drives the banner. */
  brokerStatus: BrokerStatusEvent | null
  /**
   * `since` of the outage whose banner the user dismissed. The banner hides
   * for THAT outage only (a new outage has a new `since`, so it reappears);
   * while hidden the nav rail keeps a red indicator on the inbox entry.
   */
  offlineBannerDismissed: number | null
  /** Companion mode (PLAN MB1): window.api is the WebSocket shim, not Electron. */
  remote: boolean
  /**
   * Mobile layout (PLAN MB3): ONLY ever true for a remote client on a coarse
   * pointer / narrow screen. The Electron window NEVER flips this — desktop
   * behavior is untouched even at narrow widths (mobile derivation rule).
   */
  mobile: boolean
  /** Remote link health (drives the "host disconnected" overlay). */
  remoteLink: RemoteState | null
  /** Compagnon dialog visibility (PLAN MB2, desktop window only). */
  companionOpen: boolean
  /** Usage-limits modal visibility (quota gauges of the detected CLIs). */
  usageOpen: boolean
  /** True while the companion LAN server is up (rail glyph glow). */
  companionRunning: boolean
  /**
   * Creates awaiting their PTY. A count, not a flag: several can be in flight
   * (a template instantiates a whole team at once).
   */
  pendingSessions: number
  /** Sandbox mode (PLAN-SANDBOX): last known status of this project, or null. */
  sandboxStatus: SandboxStatus | null
  /**
   * Cross-project kory-sbx container list (Docker view). Lives in the store,
   * not in SandboxView state: the view is unmounted on every navigation, and
   * re-querying the engine from scratch left it showing "no containers" for
   * seconds. null = never fetched (the view shows a loading line, not "empty").
   */
  sandboxContainers: SandboxContainerInfo[] | null
  /** First-run sandbox login modal (SBX3) visibility. */
  sandboxAuthOpen: boolean
  /** Sandbox image-build terminal modal (M2) visibility. */
  sandboxBuildOpen: boolean
  /**
   * A build PTY is alive. Tracked here, not in the dialog: the operator can
   * HIDE the modal and let a long build finish in the background, so the
   * dialog is not the owner of the build's lifetime.
   */
  sandboxBuilding: boolean
  /** The build was started from "Re-authenticate": open the login after it. */
  sandboxAuthAfterBuild: boolean

  init(): Promise<void>
  setView(view: DeckView): void
  /** Hide the offline banner for the current outage (red rail dot remains). */
  dismissOfflineBanner(): void
  /** Re-read the claude-peers core config summary (Settings > Broker). */
  refreshPeersConfig(): Promise<void>
  /** Write the `offline_replica` opt-in; the store takes the RE-READ summary. */
  setOfflineReplica(value: boolean): Promise<void>
  openCompanion(open: boolean): void
  openUsage(open: boolean): void
  /** Open the browser view, optionally docking a session next to it (D1). */
  openBrowser(pairedId?: string | null): void
  /** Change/detach the docked session without leaving the browser view. */
  setBrowserPaired(id: string | null): void
  /** REC start/stop marker (null = idle). */
  setRecordingSince(at: number | null): void
  /** Open/close the operator inbox panel (opening clears the unread count). */
  openInbox(open: boolean): void
  /**
   * Mark a family 1/2 entry as seen (opened, still to be handled). Never
   * downgrades an acked entry — closing a modal must not undo an ack, and
   * opening one must not acknowledge anything.
   */
  markInboxSeen(entry: AckableInboxEntry): void
  /** Acknowledge a family 1/2 entry (typed so a blocking question cannot be passed). */
  ackInboxEntry(entry: AckableInboxEntry): void
  /** Store/clear a reply draft for an entry key ('' drops the key). */
  setInboxReplyDraft(key: string, text: string): void
  /** Drop a resolved blocking question from the pending list (optimistic). */
  clearPendingApproval(id: string): void
  /** Open a pending draft: create the pre-filled graph and navigate to it. */
  openGraphDraft(draft: DeckGraphDraft): Promise<void>
  /**
   * Offline replica: arbitrate one conflict. The resolved card is dropped
   * from the local list optimistically; the next poll is what confirms it,
   * exactly like clearPendingApproval above.
   */
  resolveRoadmapConflict(id: string, choice: RoadmapSyncResolution): Promise<void>
  /** Open (id) or close (null) the conflict-resolution dialog. */
  openRoadmapConflict(id: string | null): void
  /** GraphView consumed the navigation request. */
  clearGraphFocus(): void
  /** Open the diff panel on a dir (null closes it). */
  openDiff(target: { dir: string; title: string } | null): void
  /** Open the help assistant prefilled with a code-selection question (GX7). */
  openHelpAssistant(seed: { question: string; selection: HelpSelection }): void
  /** HelpAssistant consumed the seed. */
  clearHelpSeed(): void
  /** Jump to the roadmap view with a prefilled create form (GX8). */
  openRoadmapDraft(seed: { title: string; kind: RoadmapKind; description: string }): void
  /** RoadmapView consumed the seed. */
  clearRoadmapSeed(): void
  setSelected(id: string | null): void
  setMaximized(id: string | null): void
  openSearch(open: boolean): void
  openSettings(open: boolean): void
  openWorkspaces(open: boolean, opts?: { loadOnly?: boolean }): void
  openNewClearConfirm(open: boolean): void
  openSaveAs(open: boolean): void
  openTemplates(open: boolean, opts?: { manage?: boolean; composer?: boolean }): void
  /** TemplatesDialog consumed the composer seed (card 290a14e2, same one-shot
   *  pattern as clearHelpSeed/clearRoadmapSeed below). */
  clearTemplatesComposerSeed(): void
  openExportTemplate(open: boolean): void
  refreshTemplates(): Promise<void>
  exportTemplate(name: string, local: boolean): Promise<void>
  applyTemplate(path: string, mode: 'append' | 'replace'): Promise<void>
  removeTemplate(path: string): Promise<void>
  setSidebarWidth(px: number): void
  /** Fold/unfold the Agents sidebar and persist it (same channel as the width). */
  setSidebarCollapsed(collapsed: boolean): void
  /** Fold/unfold the Roadmap filter panel and persist it (card 7a2e76c6). */
  setRoadmapFiltersCollapsed(collapsed: boolean): void
  /** Fold/unfold the Graph chats panel and persist it (card 67c21dd5). */
  setGraphListCollapsed(collapsed: boolean): void
  /** Toggle the pick-context dialog on browser element pick and persist it. */
  setPickContextPrompt(enabled: boolean): void

  /**
   * Toast policy (PLAN O5): reserved for the outcome of a DIRECT user action.
   * Background/systemic failures go to the log + journal (+ banner when the
   * broker is down) -- never toast them. Same key throttled to one per 5 s.
   */
  showToast(key: string, variant?: 'success' | 'info' | 'error', opts?: { raw?: boolean }): void
  saveCurrent(): Promise<void>
  saveAs(name: string): Promise<void>
  requestRestore(id: string): void
  confirmRestore(): Promise<void>
  cancelRestore(): void
  newClear(): Promise<void>
  createSession(input: CreateSessionInput): Promise<void>
  removeSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  setColor(id: string, color: string): Promise<void>
  restartSession(id: string): Promise<void>
  /** Per-session quota auto-resume override (context menu). */
  setAutoResume(id: string, enabled: boolean): Promise<void>
  /** Manual dismiss for a stuck "needs you" flag (card 4f0143ff). */
  clearAttention(id: string): Promise<void>
  reorderSessions(ids: string[]): Promise<void>
  updateConfig(patch: Partial<AppConfig>): Promise<void>
  /** Broadcast a free-text operator message to all peers in the active group. */
  broadcastAnnounce(text: string): Promise<void>

  /** Refresh the sandbox status (`force` re-probes the engine). */
  refreshSandbox(force?: boolean): Promise<void>
  /** Refresh the cross-project container list (independent of the status). */
  refreshSandboxContainers(): Promise<void>
  /** Patch this project's sandbox settings (main refuses while sessions run). */
  patchSandbox(patch: SandboxSettingsPatch): Promise<void>
  openSandboxAuth(open: boolean): void
  openSandboxBuild(open: boolean): void
  /** Open the build modal and spawn the build (no-op if one already runs). */
  startSandboxBuild(thenAuth: boolean, custom?: boolean): Promise<void>
  /** The build PTY exited: clear the flag, refresh, and chain the login. */
  finishSandboxBuild(code: number): void

  refreshWorkspaces(): Promise<void>
  /**
   * null iff nothing was captured (saveAuto's empty-snapshot guard, b8d65b24):
   * the caller decides whether that is worth surfacing (an explicit gesture
   * must not report success on a no-op; an automatic save stays silent either
   * way).
   */
  saveWorkspace(name?: string): Promise<WorkspaceSummary | null>
  restoreWorkspace(id: string): Promise<void>
  removeWorkspace(id: string): Promise<void>
}

// Monotonic token so a newer toast cancels the prior auto-clear timer.
let toastToken = 0
// Last display time per toast key (throttle, PLAN O5).
const lastToastAt = new Map<string, number>()

/**
 * Readable text for an error crossing the IPC boundary. Electron wraps every
 * rejected `invoke` as `Error invoking remote method 'chan': Error: <cause>` —
 * the channel name means nothing to the operator and buries the actual cause,
 * so strip the wrapper and keep what the main process actually said.
 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const m = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]+)$/.exec(raw)
  return m?.[1] ?? raw
}

/**
 * Guard a direct user action (PLAN O6): before this, an IPC rejection became
 * an unhandled promise rejection and the click silently no-oped. Now it lands
 * in main.log + the journal and surfaces as an error toast (raw message).
 */
/**
 * Returns whether the call succeeded, so a caller that has to RENDER the
 * failure (rather than only toast it) can tell "not read yet" from "read and
 * failed". Most callers ignore it and keep the fire-and-forget shape.
 */
async function guarded(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (e) {
    const msg = errorText(e)
    try {
      window.api.reportError('store', `${label} failed: ${msg}`)
    } catch {
      // Reporting must never mask the toast.
    }
    useDeck.getState().showToast(`${label}: ${msg}`, 'error', { raw: true })
    return false
  }
}

/**
 * Courrier entries still in the operator's way: family 1/2 entries whose
 * DURABLE state is anything but 'acked' (absent from the map = unread).
 *
 * This REPLACED a session counter (`inboxUnread`, now deleted rather than
 * left dead beside its successor): it started at 0 on every boot and was
 * zeroed the moment the panel opened, so ten unhandled messages showed a
 * badge of zero after a Deck restart — a confident zero over things nobody
 * had handled. The card's promise is that nothing leaves the operator's path
 * until acknowledged, and only the persisted state holds that across a
 * restart.
 */
export function inboxPendingCount(s: DeckState): number {
  return s.inboxMessages.reduce(
    (n, message) => (s.inboxAckState[inboxEntryKey({ kind: 'message', message })] === 'acked' ? n : n + 1),
    0
  )
}

/**
 * The single producer of the Courrier attention badge, shared by every
 * navigation bar -- bars must call this, never re-add the terms themselves.
 * Blocking questions count until resolved, drafts until opened.
 */
export function inboxBadgeCount(s: DeckState): number {
  return inboxPendingCount(s) + s.pendingApprovals.length + s.graphDrafts.length
}

/**
 * Whether an ACTION is awaited (drives the rail glyph's attention glow), as
 * opposed to something merely unread. Same single-producer rule as above.
 */
export function inboxAwaitsAction(s: DeckState): boolean {
  return s.pendingApprovals.length + s.graphDrafts.length > 0
}

/**
 * Cards of THIS project awaiting the operator's arbitration -- the Roadmap
 * rail badge. Counts the conflicts actually listed, never
 * `roadmapSync.status.conflicts`, which the broker computes across every
 * project: a badge of 3 leading to a board showing none would be a lie.
 */
export function roadmapConflictCount(s: DeckState): number {
  return s.roadmapSync.conflicts.length
}

export const useDeck = create<DeckState>((set, get) => ({
  sessions: [],
  config: null,
  // The Deck opens on Home: the supervisor is the entry point of the app (it
  // spawns lazily on that view's first visit), so landing there is what starts
  // the session that pilots everything else.
  view: 'home',
  dict: {},
  availableLocales: [],
  selectedId: null,
  maximizedId: null,
  searchOpen: false,
  settingsOpen: false,
  workspacesOpen: false,
  workspacesLoadOnly: false,
  confirmNewClearOpen: false,
  saveAsOpen: false,
  templatesOpen: false,
  templatesManage: false,
  templatesComposerSeed: 0,
  exportTemplateOpen: false,
  templates: [],
  restoreLossId: null,
  toast: null,
  toastVariant: 'success',
  toastRaw: false,
  currentWorkspaceName: null,
  workspaces: [],
  sidebarWidth: 260,
  sidebarCollapsed: false,
  roadmapFiltersCollapsed: false,
  graphListCollapsed: false,
  pickContextPrompt: true,
  inboxMessages: [],
  inboxOpen: false,
  pendingApprovals: [],
  inboxAckState: {},
  inboxReplyDrafts: {},
  graphDrafts: [],
  // 'local' is the inert default: a Deck that has not heard from its broker
  // yet must render as a plain non-replica one, never raise the offline
  // banner on a state nobody reported.
  roadmapSync: { status: { mode: 'local' }, conflicts: [] },
  peersConfig: null,
  peersConfigError: false,
  roadmapConflictId: null,
  graphFocus: null,
  diffTarget: null,
  helpSeed: null,
  roadmapSeed: null,
  browserPairedId: null,
  browserOpened: false,
  recordingSince: null,
  initError: null,
  brokerStatus: null,
  offlineBannerDismissed: null,
  remote: false,
  mobile: false,
  remoteLink: null,
  companionOpen: false,
  usageOpen: false,
  companionRunning: false,
  sandboxStatus: null,
  sandboxContainers: null,
  pendingSessions: 0,
  sandboxAuthOpen: false,
  sandboxBuildOpen: false,
  sandboxBuilding: false,
  sandboxAuthAfterBuild: false,

  async init() {
    // Companion mode flags (PLAN MB1/MB3): computed once — the desktop window
    // can never become 'mobile' (remote is the hard precondition).
    const remote = remoteInstalled()
    const mobile =
      remote &&
      (window.matchMedia?.('(pointer: coarse)').matches === true || window.innerWidth < 700)
    set({ initError: null, remote, mobile, remoteLink: remote ? 'connected' : null })
    if (remote) {
      onRemoteState((s) => set({ remoteLink: s }))
      // Light→full resume or reconnect (MB5): re-hydrate what push events may
      // have missed while the stream was down.
      onRemoteRefresh(() => {
        void window.api.listSessions().then((sessions) => set({ sessions }))
        void window.api.getBrokerStatus().then((status) => set({ brokerStatus: status }))
      })
    }
    let sessions: SessionRuntime[]
    let config: AppConfig
    let i18n: Awaited<ReturnType<typeof window.api.getI18n>>
    let workspaces: WorkspaceSummary[]
    let templates: TemplateSummary[]
    try {
      ;[sessions, config, i18n, workspaces, templates] = await Promise.all([
        window.api.listSessions(),
        window.api.getConfig(),
        window.api.getI18n(),
        window.api.listWorkspaces(),
        window.api.listTemplates()
      ])
    } catch (e) {
      // Without this catch a single failed bootstrap invoke left the splash
      // spinning forever (PLAN O4). Surface it + let the operator retry.
      const message = e instanceof Error ? e.message : String(e)
      window.api.reportError('init', `bootstrap failed: ${message}`)
      set({ initError: message })
      return
    }
    set({
      sessions,
      config,
      dict: i18n.dict,
      availableLocales: i18n.available,
      workspaces,
      templates,
      sidebarWidth: config.sidebarWidth,
      sidebarCollapsed: config.sidebarCollapsed,
      roadmapFiltersCollapsed: config.roadmapFiltersCollapsed,
      graphListCollapsed: config.graphListCollapsed,
      pickContextPrompt: config.pickContextPrompt,
      selectedId: get().selectedId ?? sessions[0]?.id ?? null
    })

    window.api.onSessionsChanged((next) => {
      const { selectedId, maximizedId, browserPairedId } = get()
      const stillExists = next.some((s) => s.id === selectedId)
      const maxStillExists = next.some((s) => s.id === maximizedId)
      const pairedStillExists = next.some((s) => s.id === browserPairedId)
      set({
        sessions: next,
        selectedId: stillExists ? selectedId : (next[0]?.id ?? null),
        maximizedId: maxStillExists ? maximizedId : null,
        browserPairedId: pairedStillExists ? browserPairedId : null
      })
    })
    window.api.onMenuSettings(() => get().openSettings(true))
    window.api.onMenuNewClear(() => set({ confirmNewClearOpen: true }))
    window.api.onMenuSave(() => void get().saveCurrent())
    window.api.onMenuSaveAs(() => {
      set({ saveAsOpen: true })
      // Refresh so the dialog's duplicate-name check sees the current list.
      void get().refreshWorkspaces()
    })
    window.api.onMenuRestore(() => get().openWorkspaces(true))
    window.api.onMenuListWorkspaces(() => get().openWorkspaces(true))
    window.api.onMenuExportTemplate(() => get().openExportTemplate(true))
    window.api.onMenuNewTemplate(() => get().openTemplates(true, { manage: true, composer: true }))
    window.api.onMenuImportTemplate(() => get().openTemplates(true, { manage: true }))
    window.api.onWorkspaceCurrent((ws) => {
      set({ currentWorkspaceName: ws?.name ?? null })
      // `workspaces` is a bootstrap snapshot never repushed after mount --
      // the current run's own workspace is minted AFTER bootstrap, so it
      // never enters the list on its own. Refresh on every emission of
      // `workspace:current`, summary or null alike (null still means the
      // list changed): the autosave timer callback in
      // desktop/src/main/index.ts (service.on('changed', ...)), and the
      // `app:new-clear`, `workspace:restore`, `template:apply` handlers in
      // desktop/src/main/ipc.ts.
      void get().refreshWorkspaces()
    })
    // rateLimited/resumeAt state flows through onSessionsChanged (the service
    // broadcasts on every episode transition); this listener only surfaces the
    // injection moment as a toast.
    window.api.onSessionQuota((e) => {
      if (e.resumed) get().showToast('toast.quotaResumed', 'info')
    })
    // System-notification click (PLAN C11): jump to the waiting session.
    window.api.onFocusSession((id) => {
      set({ view: 'agents', selectedId: id })
    })
    // Operator inbox (PLAN C12): batches drained by the main-process poll.
    window.api.onInboxMessages((batch) => {
      const { inboxMessages } = get()
      // Dedupe by broker id: the disk-history hydration below and the live
      // stream can race on the same batch after a restart.
      const fresh = batch.filter((m) => !inboxMessages.some((x) => x.id === m.id))
      // No unread COUNTER is kept: the badge is derived from the persisted
      // ack state (`inboxBadgeCount`), which is the only version that
      // survives a Deck restart.
      set({ inboxMessages: [...inboxMessages, ...fresh].slice(-500) })
    })
    // Hydrate the persisted inbox history: the durable copy across Deck
    // restarts/crashes (Courrier lot 1B -- session_id is minted in-memory and
    // never survives a restart either, so this journal is load-bearing for a
    // different reason now; see desktop/src/main/inbox-store.ts).
    void window.api.inboxHistory().then((history) => {
      const { inboxMessages } = get()
      const known = new Set(inboxMessages.map((m) => m.id))
      const merged = [...history.filter((m) => !known.has(m.id)), ...inboxMessages]
      set({ inboxMessages: merged.slice(-500) })
    })
    // Courrier lot 1D/1E (card 1e81ee7b): main truncated or removed entries
    // from the journal (session purge, or a manual inboxDelete) -- the
    // journal is now the source of truth for what remains, so this is a full
    // REPLACE, not a merge (unlike the two listeners above, which only ever
    // ADD).
    window.api.onInboxCleared(() => {
      void window.api.inboxHistory().then((history) => set({ inboxMessages: history }))
    })
    // Family 3: the broker's pending blocking questions, pushed as a WHOLE
    // list. Replacing (not merging) is what makes a question answered from
    // the phone disappear here without any local bookkeeping.
    window.api.onPendingApprovals((approvals) => set({ pendingApprovals: approvals }))
    // Durable read-state of the family 1/2 entries, read once at startup: the
    // three Courrier states must survive a Deck restart, so 'seen' is not a
    // render-time flag.
    void window.api
      .inboxAckState()
      .then((inboxAckState) => set({ inboxAckState }))
      .catch((e) => window.api.reportError('store', `inbox ack state: ${errorText(e)}`))
    // Pending graph drafts: full list pushed by the main-process poll.
    window.api.onGraphDrafts((drafts) => set({ graphDrafts: drafts }))
    // Replication state: pushed only when it actually changed (main-side
    // signature compare), so this replaces the whole state each time.
    window.api.onRoadmapSync((roadmapSync) => set({ roadmapSync }))
    // Core-config summary, re-broadcast by main after a successful write so
    // every open surface shows the file rather than its own optimistic guess.
    window.api.onPeersConfig((peersConfig) => set({ peersConfig }))
    // Notification click on an inbox message: surface the panel.
    window.api.onInboxOpen(() => get().openInbox(true))
    // Broker reachability (PLAN O5): transitions pushed by main + the current
    // state fetched once (covers a reloaded renderer during an outage).
    window.api.onBrokerStatus((status) => set({ brokerStatus: status }))
    window.api.onSandboxChanged((sandboxStatus) => set({ sandboxStatus }))
    // One hydration at boot so the rail glyph is truthful before the Docker
    // view has ever been opened. Best-effort: a failure here must not break
    // startup, and the rail simply renders the glyph plain.
    void window.api
      .sandboxStatus()
      .then((sandboxStatus) => set({ sandboxStatus }))
      .catch(() => {})
    void window.api.getBrokerStatus().then((status) => set({ brokerStatus: status }))
    // Companion server status (PLAN MB2): rail glyph glow while it runs. A
    // remote client is 'remote-blocked' on the status invoke — the event push
    // still keeps its flag honest (harmlessly unused there).
    window.api.onCompanionChanged((info) => set({ companionRunning: info.running }))
    if (!remote) {
      void window.api
        .companionStatus()
        .then((info) => set({ companionRunning: info.running }))
        .catch(() => undefined)
    }
    window.api.onConfigChanged((next) => {
      const prevLocale = get().config?.locale
      set({ config: next })
      // Locale changed -> refetch the dict so the UI re-renders in the new language.
      if (next.locale !== prevLocale) {
        void window.api.getI18n().then((i18n) => set({ dict: i18n.dict }))
      }
    })
  },

  setView: (view) => set({ view, ...(view === 'browser' ? { browserOpened: true } : null) }),
  openCompanion: (open) => set({ companionOpen: open }),
  openUsage: (open) => set({ usageOpen: open }),
  openBrowser: (pairedId) =>
    set((s) => ({
      view: 'browser',
      browserOpened: true,
      browserPairedId: pairedId === undefined ? s.browserPairedId : pairedId
    })),
  setBrowserPaired: (id) => set({ browserPairedId: id }),
  setRecordingSince: (at) => set({ recordingSince: at }),
  // Opening the panel does not zero anything: an entry leaves the badge only
  // when it is acked, not when it is glanced at.
  openInbox: (open) => set({ inboxOpen: open }),
  // Opening an entry is NOT acknowledging it: 'seen' is the middle state, and
  // it must never overwrite an 'acked' one (a re-opened acked entry stays
  // acked). Optimistic locally, durable main-side.
  markInboxSeen: (entry) => {
    const key = inboxEntryKey(entry)
    if (get().inboxAckState[key]) return
    set((s) => ({ inboxAckState: { ...s.inboxAckState, [key]: 'seen' } }))
    void guarded('inbox seen', () => window.api.inboxMarkSeen(entry))
  },
  ackInboxEntry: (entry) => {
    const key = inboxEntryKey(entry)
    set((s) => ({ inboxAckState: { ...s.inboxAckState, [key]: 'acked' } }))
    void guarded('inbox ack', () => window.api.inboxAck(entry))
  },
  // A cleared draft DROPS its key rather than storing '': the map is keyed by
  // entries that rotate out of the list, so empty strings would accumulate.
  setInboxReplyDraft: (key, text) =>
    set((s) => {
      const next = { ...s.inboxReplyDrafts }
      if (text) next[key] = text
      else delete next[key]
      return { inboxReplyDrafts: next }
    }),
  clearPendingApproval: (id) =>
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((a) => a.id !== id) })),
  openGraphDraft: async (draft) => {
    // Main creates the pre-filled doc and flips the broker status; the local
    // list is trimmed optimistically (the next poll confirms).
    await guarded('open draft', async () => {
      const res = await window.api.graphDraftOpen(draft)
      set((s) => ({
        graphDrafts: s.graphDrafts.filter((d) => d.id !== draft.id),
        inboxOpen: false,
        view: 'graph',
        graphFocus: { docId: res.docId, nodeId: res.nodeId }
      }))
    })
  },
  resolveRoadmapConflict: async (id, choice) => {
    await guarded('resolve conflict', async () => {
      await window.api.resolveRoadmapConflict(id, choice)
      set((s) => ({
        roadmapSync: {
          ...s.roadmapSync,
          conflicts: s.roadmapSync.conflicts.filter((c) => c.local.id !== id)
        },
        roadmapConflictId: s.roadmapConflictId === id ? null : s.roadmapConflictId
      }))
    })
  },
  refreshPeersConfig: async () => {
    const ok = await guarded('broker settings', async () => {
      set({ peersConfig: await window.api.getPeersConfig() })
    })
    set({ peersConfigError: !ok })
  },
  // The main process answers with the summary RE-READ from disk, so a refused
  // write (malformed file, non-boolean) surfaces as a toast and the checkbox
  // snaps back to what the file actually says.
  setOfflineReplica: async (value) => {
    await guarded('replica mode', async () => {
      set({ peersConfig: await window.api.setOfflineReplica(value) })
    })
  },
  openRoadmapConflict: (id) => set({ roadmapConflictId: id }),
  clearGraphFocus: () => set({ graphFocus: null }),
  openDiff: (target) => set({ diffTarget: target }),
  openHelpAssistant: (seed) => set({ helpSeed: seed }),
  clearHelpSeed: () => set({ helpSeed: null }),
  openRoadmapDraft: (seed) => set({ roadmapSeed: seed, view: 'roadmap' }),
  clearRoadmapSeed: () => set({ roadmapSeed: null }),
  setSelected: (id) => set({ selectedId: id }),
  setMaximized: (id) => set({ maximizedId: id }),
  openSearch: (open) => set({ searchOpen: open }),
  openSettings: (open) => set({ settingsOpen: open }),
  openWorkspaces: (open, opts) => {
    set({ workspacesOpen: open, workspacesLoadOnly: open ? !!opts?.loadOnly : false })
    if (open) void get().refreshWorkspaces()
  },
  openNewClearConfirm: (open) => set({ confirmNewClearOpen: open }),
  openSaveAs: (open) => set({ saveAsOpen: open }),
  openTemplates: (open, opts) => {
    set((s) => ({
      templatesOpen: open,
      templatesManage: open ? !!opts?.manage : false,
      // Only bumped when a blank composer is actually requested, so a plain
      // "Use template" / "Manage templates" open never re-triggers it. On
      // CLOSE, forced back to 0 unconditionally (card 290a14e2 review round
      // 2): TemplatesDialog already self-clears it after consuming it, so no
      // open path leaves a stray non-zero value today -- but that was an
      // invariant held by consumer diligence, not guaranteed at the source.
      // Zeroing it here on every close makes it true by construction.
      templatesComposerSeed: open ? (opts?.composer ? s.templatesComposerSeed + 1 : s.templatesComposerSeed) : 0
    }))
    if (open) void get().refreshTemplates()
  },
  clearTemplatesComposerSeed: () => set({ templatesComposerSeed: 0 }),
  openExportTemplate: (open) => set({ exportTemplateOpen: open }),

  async refreshTemplates() {
    await guarded('list templates', async () => {
      const templates = await window.api.listTemplates()
      set({ templates })
    })
  },

  async exportTemplate(name, local) {
    await guarded('export template', async () => {
      const path = await window.api.exportTemplate(name, local)
      set({ exportTemplateOpen: false })
      if (path) get().showToast('toast.templateExported')
    })
  },

  async applyTemplate(path, mode) {
    await guarded('apply template', async () => {
      const count = await window.api.applyTemplate(path, mode)
      // Card 96c98453: whether to show the success toast is delegated to
      // shouldShowTemplateAppliedToast (shared/template-apply-outcome.ts),
      // the same pure module the main-process handler consults for its own
      // half of this contract. null means the operator declined the
      // shell-field approval dialog -- a deliberate choice, not an error: no
      // toast, and the dialog stays open so they can pick a different
      // template. A real anomaly (containment/malformed) instead THROWS and
      // is caught above by guarded(), which shows the error toast with the
      // thrown message.
      if (!shouldShowTemplateAppliedToast(count)) return
      set({ templatesOpen: false })
      // Sessions refresh via onSessionsChanged (create/closeAll broadcast).
      get().showToast('toast.templateApplied')
    })
  },

  async removeTemplate(path) {
    await guarded('delete template', async () => {
      const ok = await window.api.deleteTemplate(path)
      // Keep the picker open; just refresh the list so the row disappears.
      await get().refreshTemplates()
      if (ok) get().showToast('toast.templateDeleted')
    })
  },

  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(520, Math.max(180, Math.round(px))) }),

  // Folded state is written through on the toggle itself: unlike the width,
  // there is no drag end to hang the persistence on, and the rail width is a
  // constant, so nothing needs to be measured before saving.
  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed })
    void get().updateConfig({ sidebarCollapsed: collapsed })
  },

  // Same write-through as the sidebar above: one toggle, one persisted flag.
  setRoadmapFiltersCollapsed: (collapsed) => {
    set({ roadmapFiltersCollapsed: collapsed })
    void get().updateConfig({ roadmapFiltersCollapsed: collapsed })
  },

  // Same write-through as the two above (card 67c21dd5).
  setGraphListCollapsed: (collapsed) => {
    set({ graphListCollapsed: collapsed })
    void get().updateConfig({ graphListCollapsed: collapsed })
  },

  // Same write-through as the toggles above: one setting, one persisted flag.
  setPickContextPrompt: (enabled) => {
    set({ pickContextPrompt: enabled })
    void get().updateConfig({ pickContextPrompt: enabled })
  },

  dismissOfflineBanner: () => {
    const status = get().brokerStatus
    if (status && !status.up) set({ offlineBannerDismissed: status.since })
  },

  showToast: (key, variant = 'success', opts) => {
    // Throttle repeats (PLAN O5): a failing action retried in a loop must not
    // strobe the UI -- one toast per key per 5 s.
    const now = Date.now()
    const last = lastToastAt.get(key) ?? 0
    if (now - last < 5000) return
    lastToastAt.set(key, now)
    set({ toast: key, toastVariant: variant, toastRaw: opts?.raw ?? false })
    const token = ++toastToken
    setTimeout(() => {
      if (toastToken === token) set({ toast: null })
    }, 3000)
  },

  async saveCurrent() {
    await guarded('save workspace', async () => {
      const summary = await get().saveWorkspace()
      // null: the explicit gesture had nothing to capture (only the
      // supervisor alive, or a fresh launch) -- report that, not a false
      // "saved" (b8d65b24 follow-up: the same guard silently protecting
      // auto-save must not silently lie to an explicit click too).
      if (summary) {
        get().showToast('toast.workspaceSaved')
      } else {
        get().showToast('toast.nothingToSave', 'info')
      }
    })
  },

  async saveAs(name) {
    const n = name.trim()
    if (!n) return
    try {
      await get().saveWorkspace(n)
    } catch (e) {
      // Main rejected (e.g. duplicate name) -> keep the dialog open, no toast.
      // The dialog already prevents duplicates; this is a safety net, but a
      // real main-side failure must still leave a trace (no silent errors).
      window.api.reportError('workspace', `saveAs(${n}) failed: ${errorText(e)}`)
      return
    }
    set({ saveAsOpen: false })
    get().showToast('toast.workspaceSaved')
  },

  requestRestore: (id) => {
    // Loss warning only when the current window already has sessions.
    if (get().sessions.length > 0) set({ restoreLossId: id })
    else void get().restoreWorkspace(id)
  },

  async confirmRestore() {
    const id = get().restoreLossId
    set({ restoreLossId: null })
    if (id) await get().restoreWorkspace(id)
  },

  cancelRestore: () => set({ restoreLossId: null }),

  async newClear() {
    await guarded('new clear', async () => {
      await window.api.newClear()
      // sessions empty out via onSessionsChanged; close the confirm.
      set({ confirmNewClearOpen: false })
    })
  },

  async createSession(input) {
    // A sandboxed spawn goes through the container gate before a PTY exists,
    // so the click has nothing to show for seconds. Count the pending creates
    // (several can be in flight, e.g. a template) and let the grid render a
    // placeholder tile -- an unresponsive button reads as a broken app.
    set({ pendingSessions: get().pendingSessions + 1 })
    await guarded('create session', async () => {
      try {
        const created = await window.api.createSession(input)
        set({ selectedId: created.id })
        // sessions list refreshes via onSessionsChanged
      } catch (e) {
        // SBX3: the pre-spawn gate refused because the sandbox is not logged
        // in — route to the login modal instead of a cryptic error toast.
        if (String(e instanceof Error ? e.message : e).includes('sandbox-auth-required')) {
          set({ sandboxAuthOpen: true })
          return
        }
        throw e
      }
    })
    // Cleared whatever happened: guarded() swallows failures after reporting
    // them, and a placeholder left behind would outlive the app's patience.
    set({ pendingSessions: Math.max(0, get().pendingSessions - 1) })
  },

  async removeSession(id) {
    await guarded('close session', async () => {
      await window.api.removeSession(id)
      if (get().maximizedId === id) set({ maximizedId: null })
    })
  },

  async renameSession(id, name) {
    await guarded('rename session', () => window.api.renameSession(id, name))
  },

  async setColor(id, color) {
    await guarded('set color', () => window.api.setSessionColor(id, color))
  },

  async restartSession(id) {
    await guarded('restart session', () => window.api.restartSession(id))
  },

  async setAutoResume(id, enabled) {
    // The updated override arrives via onSessionsChanged (broadcast).
    await guarded('auto-resume', () => window.api.setSessionAutoResume(id, enabled))
  },

  async clearAttention(id) {
    // The cleared flag arrives via onSessionsChanged (broadcast).
    await guarded('clear attention', () => window.api.clearAttention(id))
  },

  async reorderSessions(ids) {
    // The new order arrives via onSessionsChanged (reorder broadcasts 'changed').
    await guarded('reorder', () => window.api.reorderSessions(ids))
  },

  async updateConfig(patch) {
    await guarded('save settings', async () => {
      const config = await window.api.setConfig(patch)
      set({ config })
    })
  },

  async broadcastAnnounce(text) {
    const body = text.trim()
    if (!body) return
    await guarded('announce', async () => {
      const sent = await window.api.announce(body)
      get().showToast(sent > 0 ? 'toast.announceSent' : 'toast.announceNoPeers', sent > 0 ? 'success' : 'info')
    })
  },

  async refreshSandbox(force) {
    await guarded('sandbox status', async () => {
      const sandboxStatus = await window.api.sandboxStatus(force)
      set({ sandboxStatus })
    })
  },

  async refreshSandboxContainers() {
    try {
      const sandboxContainers = await window.api.sandboxList()
      set({ sandboxContainers })
    } catch {
      // Engine missing/down: the Docker view's mode card explains why. An
      // empty list (not the stale one) keeps the view truthful: no engine
      // means nothing can be started/stopped from here anyway.
      set({ sandboxContainers: [] })
    }
  },

  async patchSandbox(patch) {
    await guarded('sandbox settings', async () => {
      const sandboxStatus = await window.api.sandboxPatchSettings(patch)
      set({ sandboxStatus })
      if (patch.enabled !== undefined) {
        get().showToast(patch.enabled ? 'toast.sandboxOn' : 'toast.sandboxOff')
      } else {
        get().showToast('toast.sandboxSettingsSaved')
      }
    })
  },

  openSandboxAuth: (open) => set({ sandboxAuthOpen: open }),
  openSandboxBuild: (open) => set({ sandboxBuildOpen: open }),

  async startSandboxBuild(thenAuth, custom) {
    // The build keeps running when the modal is HIDDEN, so ownership of its
    // lifecycle lives here rather than in the dialog: the dialog can be
    // unmounted while the PTY is still working.
    const already = get().sandboxBuilding
    set({ sandboxAuthAfterBuild: thenAuth, sandboxBuildOpen: true })
    if (already) return
    // Flip the flag BEFORE awaiting. Opening the modal mounts the dialog
    // synchronously, and its own effect calls back in here; without the
    // optimistic flag both calls would see "not building" and spawn twice.
    set({ sandboxBuilding: true })
    try {
      await window.api.sandboxImageBuild(custom ? 'custom' : undefined)
    } catch (e) {
      // Roll back: with no PTY there is no exit event to clear the flag, and a
      // stuck "building" would hide the Build button for the rest of the run.
      set({ sandboxBuilding: false, sandboxAuthAfterBuild: false })
      const msg = errorText(e)
      window.api.reportError('sandbox', `image build failed to start: ${msg}`)
      get().showToast(msg, 'error')
    }
  },

  finishSandboxBuild(code) {
    const chain = get().sandboxAuthAfterBuild
    set({ sandboxBuilding: false, sandboxAuthAfterBuild: false })
    if (code === 0) get().showToast('toast.sandboxImageBuilt')
    // Fresh image: pre-create + project the container in the background now,
    // so the first agent spawned on it skips the slow pre-flight.
    if (code === 0)
      void window.api
        .sandboxWarmUp()
        .catch((e) => window.api.reportError('sandbox', `warm-up dispatch failed: ${String(e)}`))
    void get().refreshSandbox(true)
    // Chain into the login the operator originally asked for -- but only on a
    // successful build, otherwise the auth terminal would open onto a missing
    // image and fail with the very error we are trying to avoid.
    if (code === 0 && chain) set({ sandboxBuildOpen: false, sandboxAuthOpen: true })
  },

  async refreshWorkspaces() {
    await guarded('list workspaces', async () => {
      const workspaces = await window.api.listWorkspaces()
      set({ workspaces, currentWorkspaceName: workspaces.find((w) => w.current)?.name ?? null })
    })
  },

  async saveWorkspace(name) {
    const summary = await window.api.saveWorkspace(name)
    await get().refreshWorkspaces()
    return summary
  },

  async restoreWorkspace(id) {
    await guarded('restore workspace', async () => {
      // Card 07134c6a: the IPC contract WAS a plain boolean by deliberate
      // choice (this comment used to say so) -- that choice stopped holding
      // the moment restore() grew a sixth failure reason (a lock-race that
      // fires AFTER sessions were already swapped): a client-side guess from
      // a bare boolean could not tell an operator's own deliberate refusal
      // apart from a stale lock, and got it wrong for 3 of 6 real causes.
      // The contract now carries the real reason (workspaceRestoreOrThrow,
      // shared/workspace-restore-outcome.ts); no more guessing here.
      const outcome = await window.api.restoreWorkspace(id)
      // Sessions refresh via onSessionsChanged (restoreFrom broadcasts 'changed').
      await get().refreshWorkspaces()
      if (outcome.applied) {
        // Close the selection window once a workspace has been loaded.
        set({ workspacesOpen: false })
        return
      }
      const toastKey = workspaceRestoreToastKeyFor(outcome.reason)
      // shell-declined / cwd-declined resolve to null on purpose: the
      // operator just made that choice at the approval dialog, so a toast
      // would be redundant, and showing the WRONG one (today's bug) is
      // worse than showing none.
      if (toastKey) get().showToast(toastKey, 'info')
    })
  },

  async removeWorkspace(id) {
    await guarded('delete workspace', async () => {
      await window.api.deleteWorkspace(id)
      await get().refreshWorkspaces()
    })
  }
}))
