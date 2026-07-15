import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  CreateSessionInput,
  DeckApi,
  DeckView,
  HelpExchange,
  LaunchConfig,
  PtyDataEvent,
  PtyExitEvent,
  RoadmapListFilters,
  RoadmapUpsertFields,
  SessionQuotaEvent,
  SessionRuntime,
  SessionThinkingEvent,
  WorkspaceSummary
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * Multiplex a high-cardinality channel: a single ipcRenderer.on fans out to a
 * Set of subscriber callbacks. Keeps the ipcRenderer listener count at one per
 * channel regardless of how many tiles subscribe (avoids MaxListenersExceeded).
 */
function multiplex<T>(channel: string): (cb: (payload: T) => void) => () => void {
  const subscribers = new Set<(payload: T) => void>()
  ipcRenderer.on(channel, (_e, payload: T) => {
    for (const cb of subscribers) {
      try {
        cb(payload)
      } catch (err) {
        // One bad subscriber must not break dispatch to the others.
        console.error(`[preload] ${channel} subscriber threw:`, err)
      }
    }
  })
  return (cb) => {
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  }
}

const onPtyDataMux = multiplex<PtyDataEvent>('pty:data')
const onPtyExitMux = multiplex<PtyExitEvent>('pty:exit')

const api: DeckApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (input: CreateSessionInput) => ipcRenderer.invoke('sessions:create', input),
  removeSession: (id: string) => ipcRenderer.invoke('sessions:remove', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('sessions:rename', id, name),
  setSessionColor: (id: string, color: string) =>
    ipcRenderer.invoke('sessions:set-color', id, color),
  restartSession: (id: string) => ipcRenderer.invoke('sessions:restart', id),
  setSessionAutoResume: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('sessions:set-auto-resume', id, enabled),
  peekNextColor: () => ipcRenderer.invoke('sessions:peek-next-color'),
  reorderSessions: (ids: string[]) => ipcRenderer.invoke('sessions:reorder', ids),
  newClear: () => ipcRenderer.invoke('app:new-clear'),

  ptyInput: (id: string, data: string) => ipcRenderer.send('pty:input', id, data),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke('config:set', patch),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),

  getI18n: () => ipcRenderer.invoke('i18n:get'),

  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  saveWorkspace: (name?: string) => ipcRenderer.invoke('workspace:save', name),
  restoreWorkspace: (id: string) => ipcRenderer.invoke('workspace:restore', id),
  deleteWorkspace: (id: string) => ipcRenderer.invoke('workspace:delete', id),
  currentWorkspace: () => ipcRenderer.invoke('workspace:current'),

  listAgents: () => ipcRenderer.invoke('agents:list'),
  getLaunchConfig: () => ipcRenderer.invoke('launch:get'),
  saveLaunchConfig: (cfg: LaunchConfig) => ipcRenderer.invoke('launch:set-global', cfg),

  announce: (text: string) => ipcRenderer.invoke('announce:send', text),

  roadmapList: (filters: RoadmapListFilters) => ipcRenderer.invoke('roadmap:list', filters),
  roadmapUpsert: (fields: RoadmapUpsertFields) => ipcRenderer.invoke('roadmap:upsert', fields),
  roadmapArchive: (id: string) => ipcRenderer.invoke('roadmap:archive', id),
  importPlan: () => ipcRenderer.invoke('roadmap:import-plan'),
  removeWorktree: (path: string) => ipcRenderer.invoke('worktree:remove', path),
  listWorktrees: () => ipcRenderer.invoke('worktree:list'),
  createWorktree: (branch: string) => ipcRenderer.invoke('worktree:create', branch),
  ensureSupervisor: () => ipcRenderer.invoke('supervisor:ensure'),
  askHelp: (question: string, view: DeckView, transcript: HelpExchange[]) =>
    ipcRenderer.invoke('help:ask', question, view, transcript),

  listTemplates: () => ipcRenderer.invoke('template:list'),
  exportTemplate: (name: string, local: boolean) =>
    ipcRenderer.invoke('template:export', name, local),
  applyTemplate: (path: string, mode: 'append' | 'replace') =>
    ipcRenderer.invoke('template:apply', path, mode),
  deleteTemplate: (path: string) => ipcRenderer.invoke('template:delete', path),

  onPtyData: (cb: (e: PtyDataEvent) => void) => onPtyDataMux(cb),
  onPtyExit: (cb: (e: PtyExitEvent) => void) => onPtyExitMux(cb),
  onSessionsChanged: (cb: (sessions: SessionRuntime[]) => void) =>
    subscribe('sessions:changed', cb),
  onSessionThinking: (cb: (e: SessionThinkingEvent) => void) =>
    subscribe('session:thinking', cb),
  onSessionQuota: (cb: (e: SessionQuotaEvent) => void) => subscribe('session:quota', cb),
  onConfigChanged: (cb: (config: AppConfig) => void) => subscribe('config:changed', cb),
  onMenuSettings: (cb: () => void) => subscribe('menu:settings', () => cb()),
  onMenuNewClear: (cb: () => void) => subscribe('menu:new-clear', () => cb()),
  onMenuSave: (cb: () => void) => subscribe('menu:save', () => cb()),
  onMenuSaveAs: (cb: () => void) => subscribe('menu:save-as', () => cb()),
  onMenuRestore: (cb: () => void) => subscribe('menu:restore', () => cb()),
  onMenuListWorkspaces: (cb: () => void) => subscribe('menu:list', () => cb()),
  onMenuExportTemplate: (cb: () => void) => subscribe('menu:export-template', () => cb()),
  onMenuImportTemplate: (cb: () => void) => subscribe('menu:import-template', () => cb()),
  onWorkspaceCurrent: (cb: (ws: WorkspaceSummary | null) => void) =>
    subscribe('workspace:current', cb)
}

contextBridge.exposeInMainWorld('api', api)
