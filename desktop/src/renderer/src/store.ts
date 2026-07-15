import { create } from 'zustand'
import type {
  AppConfig,
  CreateSessionInput,
  DeckView,
  InboxMessage,
  LocaleOption,
  SessionRuntime,
  TemplateSummary,
  WorkspaceSummary
} from '@shared/types'

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
  /** Transient toast message (an i18n key), or null. */
  toast: string | null
  /** Toast colour variant. */
  toastVariant: 'success' | 'info'
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

  init(): Promise<void>
  setView(view: DeckView): void
  /** Open/close the operator inbox panel (opening clears the unread count). */
  openInbox(open: boolean): void
  setSelected(id: string | null): void
  setMaximized(id: string | null): void
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

  showToast(key: string, variant?: 'success' | 'info'): void
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

export const useDeck = create<DeckState>((set, get) => ({
  sessions: [],
  config: null,
  view: 'agents',
  dict: {},
  availableLocales: [],
  selectedId: null,
  maximizedId: null,
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
  currentWorkspaceName: null,
  workspaces: [],
  sidebarWidth: 260,
  inboxMessages: [],
  inboxUnread: 0,
  inboxOpen: false,

  async init() {
    const [sessions, config, i18n, workspaces, templates] = await Promise.all([
      window.api.listSessions(),
      window.api.getConfig(),
      window.api.getI18n(),
      window.api.listWorkspaces(),
      window.api.listTemplates()
    ])
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
      const { selectedId, maximizedId } = get()
      const stillExists = next.some((s) => s.id === selectedId)
      const maxStillExists = next.some((s) => s.id === maximizedId)
      set({
        sessions: next,
        selectedId: stillExists ? selectedId : (next[0]?.id ?? null),
        maximizedId: maxStillExists ? maximizedId : null
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
      // Cap the in-memory history; the broker already marked them delivered.
      const messages = [...inboxMessages, ...batch].slice(-200)
      set({
        inboxMessages: messages,
        inboxUnread: inboxOpen ? 0 : inboxUnread + batch.length
      })
    })
    // Notification click on an inbox message: surface the panel.
    window.api.onInboxOpen(() => get().openInbox(true))
    window.api.onConfigChanged((next) => {
      const prevLocale = get().config?.locale
      set({ config: next })
      // Locale changed -> refetch the dict so the UI re-renders in the new language.
      if (next.locale !== prevLocale) {
        void window.api.getI18n().then((i18n) => set({ dict: i18n.dict }))
      }
    })
  },

  setView: (view) => set({ view }),
  openInbox: (open) => set({ inboxOpen: open, inboxUnread: 0 }),
  setSelected: (id) => set({ selectedId: id }),
  setMaximized: (id) => set({ maximizedId: id }),
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
    const templates = await window.api.listTemplates()
    set({ templates })
  },

  async exportTemplate(name, local) {
    const path = await window.api.exportTemplate(name, local)
    set({ exportTemplateOpen: false })
    if (path) get().showToast('toast.templateExported')
  },

  async applyTemplate(path, mode) {
    await window.api.applyTemplate(path, mode)
    set({ templatesOpen: false })
    // Sessions refresh via onSessionsChanged (create/closeAll broadcast).
    get().showToast('toast.templateApplied')
  },

  async removeTemplate(path) {
    const ok = await window.api.deleteTemplate(path)
    // Keep the picker open; just refresh the list so the row disappears.
    await get().refreshTemplates()
    if (ok) get().showToast('toast.templateDeleted')
  },

  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(520, Math.max(180, Math.round(px))) }),

  showToast: (key, variant = 'success') => {
    set({ toast: key, toastVariant: variant })
    const token = ++toastToken
    setTimeout(() => {
      if (toastToken === token) set({ toast: null })
    }, 3000)
  },

  async saveCurrent() {
    await get().saveWorkspace()
    get().showToast('toast.workspaceSaved')
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
    await window.api.newClear()
    // sessions empty out via onSessionsChanged; close the confirm.
    set({ confirmNewClearOpen: false })
  },

  async createSession(input) {
    const created = await window.api.createSession(input)
    set({ selectedId: created.id })
    // sessions list refreshes via onSessionsChanged
  },

  async removeSession(id) {
    await window.api.removeSession(id)
    if (get().maximizedId === id) set({ maximizedId: null })
  },

  async renameSession(id, name) {
    await window.api.renameSession(id, name)
  },

  async setColor(id, color) {
    await window.api.setSessionColor(id, color)
  },

  async restartSession(id) {
    await window.api.restartSession(id)
  },

  async setAutoResume(id, enabled) {
    await window.api.setSessionAutoResume(id, enabled)
    // The updated override arrives via onSessionsChanged (broadcast).
  },

  async reorderSessions(ids) {
    await window.api.reorderSessions(ids)
    // The new order arrives via onSessionsChanged (reorder broadcasts 'changed').
  },

  async updateConfig(patch) {
    const config = await window.api.setConfig(patch)
    set({ config })
  },

  async broadcastAnnounce(text) {
    const body = text.trim()
    if (!body) return
    const sent = await window.api.announce(body)
    get().showToast(sent > 0 ? 'toast.announceSent' : 'toast.announceNoPeers', sent > 0 ? 'success' : 'info')
  },

  async refreshWorkspaces() {
    const workspaces = await window.api.listWorkspaces()
    set({ workspaces, currentWorkspaceName: workspaces.find((w) => w.current)?.name ?? null })
  },

  async saveWorkspace(name) {
    await window.api.saveWorkspace(name)
    await get().refreshWorkspaces()
  },

  async restoreWorkspace(id) {
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
  },

  async removeWorkspace(id) {
    await window.api.deleteWorkspace(id)
    await get().refreshWorkspaces()
  }
}))
