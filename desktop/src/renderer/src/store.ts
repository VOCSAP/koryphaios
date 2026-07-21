import { create } from 'zustand'
import type {
  AppConfig,
  BrokerStatusEvent,
  CreateSessionInput,
  DeckGraphDraft,
  DeckView,
  HelpSelection,
  InboxMessage,
  LocaleOption,
  RoadmapKind,
  SessionRuntime,
  TemplateSummary,
  WorkspaceSummary
} from '@shared/types'
import { onRemoteRefresh, onRemoteState, remoteInstalled, type RemoteState } from './remote-api'

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
  /** Operator inbox (PLAN C12): drained agent messages, newest LAST. */
  inboxMessages: InboxMessage[]
  /** Messages arrived while the panel was closed. */
  inboxUnread: number
  inboxOpen: boolean
  /** Pending graph drafts (agent-escalated questions): drive the rail glyph. */
  graphDrafts: DeckGraphDraft[]
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
  /** Boot failure message (PLAN O4): init() rejected, splash shows a retry. */
  initError: string | null
  /** Broker reachability (PLAN O5): null until main reports, drives the banner. */
  brokerStatus: BrokerStatusEvent | null
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
  /** True while the companion LAN server is up (rail glyph glow). */
  companionRunning: boolean

  init(): Promise<void>
  setView(view: DeckView): void
  openCompanion(open: boolean): void
  /** Open the browser view, optionally docking a session next to it (D1). */
  openBrowser(pairedId?: string | null): void
  /** Change/detach the docked session without leaving the browser view. */
  setBrowserPaired(id: string | null): void
  /** Open/close the operator inbox panel (opening clears the unread count). */
  openInbox(open: boolean): void
  /** Open a pending draft: create the pre-filled graph and navigate to it. */
  openGraphDraft(draft: DeckGraphDraft): Promise<void>
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
  openTemplates(open: boolean, opts?: { manage?: boolean }): void
  openExportTemplate(open: boolean): void
  refreshTemplates(): Promise<void>
  exportTemplate(name: string, local: boolean): Promise<void>
  applyTemplate(path: string, mode: 'append' | 'replace'): Promise<void>
  removeTemplate(path: string): Promise<void>
  setSidebarWidth(px: number): void

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
  reorderSessions(ids: string[]): Promise<void>
  updateConfig(patch: Partial<AppConfig>): Promise<void>
  /** Broadcast a free-text operator message to all peers in the active group. */
  broadcastAnnounce(text: string): Promise<void>

  refreshWorkspaces(): Promise<void>
  saveWorkspace(name?: string): Promise<void>
  restoreWorkspace(id: string): Promise<void>
  removeWorkspace(id: string): Promise<void>
}

// Monotonic token so a newer toast cancels the prior auto-clear timer.
let toastToken = 0
// Last display time per toast key (throttle, PLAN O5).
const lastToastAt = new Map<string, number>()

/**
 * Guard a direct user action (PLAN O6): before this, an IPC rejection became
 * an unhandled promise rejection and the click silently no-oped. Now it lands
 * in main.log + the journal and surfaces as an error toast (raw message).
 */
async function guarded(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try {
      window.api.reportError('store', `${label} failed: ${msg}`)
    } catch {
      // Reporting must never mask the toast.
    }
    useDeck.getState().showToast(`${label}: ${msg}`, 'error', { raw: true })
  }
}

export const useDeck = create<DeckState>((set, get) => ({
  sessions: [],
  config: null,
  view: 'agents',
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
  exportTemplateOpen: false,
  templates: [],
  restoreLossId: null,
  toast: null,
  toastVariant: 'success',
  toastRaw: false,
  currentWorkspaceName: null,
  workspaces: [],
  sidebarWidth: 260,
  inboxMessages: [],
  inboxUnread: 0,
  inboxOpen: false,
  graphDrafts: [],
  graphFocus: null,
  diffTarget: null,
  helpSeed: null,
  roadmapSeed: null,
  browserPairedId: null,
  browserOpened: false,
  initError: null,
  brokerStatus: null,
  remote: false,
  mobile: false,
  remoteLink: null,
  companionOpen: false,
  companionRunning: false,

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
    window.api.onMenuImportTemplate(() => get().openTemplates(true, { manage: true }))
    window.api.onWorkspaceCurrent((ws) => set({ currentWorkspaceName: ws?.name ?? null }))
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
      const { inboxMessages, inboxUnread, inboxOpen } = get()
      // Dedupe by broker id: the disk-history hydration below and the live
      // stream can race on the same batch after a restart.
      const fresh = batch.filter((m) => !inboxMessages.some((x) => x.id === m.id))
      const messages = [...inboxMessages, ...fresh].slice(-500)
      set({
        inboxMessages: messages,
        inboxUnread: inboxOpen ? 0 : inboxUnread + fresh.length
      })
    })
    // Hydrate the persisted inbox history (the broker drain is destructive:
    // this file is the only durable copy across Deck restarts/crashes).
    void window.api.inboxHistory().then((history) => {
      const { inboxMessages } = get()
      const known = new Set(inboxMessages.map((m) => m.id))
      const merged = [...history.filter((m) => !known.has(m.id)), ...inboxMessages]
      set({ inboxMessages: merged.slice(-500) })
    })
    // Pending graph drafts: full list pushed by the main-process poll.
    window.api.onGraphDrafts((drafts) => set({ graphDrafts: drafts }))
    // Notification click on an inbox message: surface the panel.
    window.api.onInboxOpen(() => get().openInbox(true))
    // Broker reachability (PLAN O5): transitions pushed by main + the current
    // state fetched once (covers a reloaded renderer during an outage).
    window.api.onBrokerStatus((status) => set({ brokerStatus: status }))
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
  openBrowser: (pairedId) =>
    set((s) => ({
      view: 'browser',
      browserOpened: true,
      browserPairedId: pairedId === undefined ? s.browserPairedId : pairedId
    })),
  setBrowserPaired: (id) => set({ browserPairedId: id }),
  openInbox: (open) => set({ inboxOpen: open, inboxUnread: 0 }),
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
    set({ templatesOpen: open, templatesManage: open ? !!opts?.manage : false })
    if (open) void get().refreshTemplates()
  },
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
      await window.api.applyTemplate(path, mode)
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
      await get().saveWorkspace()
      get().showToast('toast.workspaceSaved')
    })
  },

  async saveAs(name) {
    const n = name.trim()
    if (!n) return
    try {
      await get().saveWorkspace(n)
    } catch {
      // Main rejected (e.g. duplicate name) -> keep the dialog open, no toast.
      // The dialog already prevents duplicates; this is a safety net.
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
    await guarded('create session', async () => {
      const created = await window.api.createSession(input)
      set({ selectedId: created.id })
      // sessions list refreshes via onSessionsChanged
    })
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

  async refreshWorkspaces() {
    await guarded('list workspaces', async () => {
      const workspaces = await window.api.listWorkspaces()
      set({ workspaces, currentWorkspaceName: workspaces.find((w) => w.current)?.name ?? null })
    })
  },

  async saveWorkspace(name) {
    await window.api.saveWorkspace(name)
    await get().refreshWorkspaces()
  },

  async restoreWorkspace(id) {
    await guarded('restore workspace', async () => {
      const ok = await window.api.restoreWorkspace(id)
      // Sessions refresh via onSessionsChanged (restoreFrom broadcasts 'changed').
      await get().refreshWorkspaces()
      if (ok) {
        // Close the selection window once a workspace has been loaded.
        set({ workspacesOpen: false })
      } else {
        // Already owned by another live window (or gone) -> inform, don't restore.
        get().showToast('toast.alreadyOpen', 'info')
      }
    })
  },

  async removeWorkspace(id) {
    await guarded('delete workspace', async () => {
      await window.api.deleteWorkspace(id)
      await get().refreshWorkspaces()
    })
  }
}))
