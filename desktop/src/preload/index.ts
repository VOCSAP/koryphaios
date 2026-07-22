import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  BrokerStatusEvent,
  CreateSessionInput,
  DeckApi,
  DeckView,
  DesignPickEvent,
  HelpExchange,
  HelpSelection,
  InboxMessage,
  LaunchConfig,
  PtyDataEvent,
  PtyExitEvent,
  RoadmapListFilters,
  RoadmapUpsertFields,
  SessionAttentionEvent,
  SessionQuotaEvent,
  SessionRuntime,
  SessionThinkingEvent,
  WorkspaceSummary
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => {
    try {
      cb(payload)
    } catch (err) {
      // A throwing handler must not break the channel's later deliveries
      // (PLAN O4); mirror what multiplex() already does for pty channels.
      console.error(`[preload] ${channel} handler threw:`, err)
      ipcRenderer.send('app:report-error', 'preload', `${channel} handler threw: ${String(err)}`)
    }
  }
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
  setLead: (id: string) => ipcRenderer.invoke('sessions:set-lead', id),
  peekNextColor: () => ipcRenderer.invoke('sessions:peek-next-color'),
  reorderSessions: (ids: string[]) => ipcRenderer.invoke('sessions:reorder', ids),
  newClear: () => ipcRenderer.invoke('app:new-clear'),

  reportError: (scope: string, message: string) =>
    ipcRenderer.send('app:report-error', scope, message),

  getBrokerStatus: () => ipcRenderer.invoke('broker:status'),
  retryBroker: () => ipcRenderer.invoke('broker:retry'),

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
  roadmapDispatch: () => ipcRenderer.invoke('roadmap:dispatch'),
  roadmapWand: (draft) => ipcRenderer.invoke('roadmap:wand', draft),
  roadmapStop: (id: string) => ipcRenderer.invoke('roadmap:stop', id),
  roadmapAssign: (id: string, peerId: string) => ipcRenderer.invoke('roadmap:assign', id, peerId),
  importPlan: () => ipcRenderer.invoke('roadmap:import-plan'),
  removeWorktree: (path: string) => ipcRenderer.invoke('worktree:remove', path),
  listWorktrees: () => ipcRenderer.invoke('worktree:list'),
  createWorktree: (branch: string) => ipcRenderer.invoke('worktree:create', branch),
  journalList: (kind?: string | null) => ipcRenderer.invoke('journal:list', kind ?? null),
  journalExport: () => ipcRenderer.invoke('journal:export'),
  collectDiff: (dir: string) => ipcRenderer.invoke('diff:collect', dir),
  collectFileDiff: (dir: string, path: string) =>
    ipcRenderer.invoke('diff:collect-file', dir, path),
  reviewDiff: (dir: string) => ipcRenderer.invoke('diff:review', dir),
  explorerRoots: () => ipcRenderer.invoke('explorer:roots'),
  explorerList: (root: string, rel: string) => ipcRenderer.invoke('explorer:list', root, rel),
  explorerRead: (root: string, rel: string) => ipcRenderer.invoke('explorer:read', root, rel),
  getBrowserPreloadPath: () => ipcRenderer.invoke('browser:preload-path'),
  captureBrowser: (webContentsId: number) => ipcRenderer.invoke('browser:capture', webContentsId),
  saveAnnotation: (dataUrl: string) => ipcRenderer.invoke('browser:save-annotation', dataUrl),
  listCaptureWindows: () => ipcRenderer.invoke('design:list-windows'),
  captureWindow: (id: string) => ipcRenderer.invoke('design:capture-window', id),
  ensureSupervisor: () => ipcRenderer.invoke('supervisor:ensure'),
  askHelp: (question: string, view: DeckView, transcript: HelpExchange[], selection?: HelpSelection) =>
    ipcRenderer.invoke('help:ask', question, view, transcript, selection),
  askDigest: () => ipcRenderer.invoke('help:digest'),

  listTemplates: () => ipcRenderer.invoke('template:list'),
  readTemplateFile: (path: string) => ipcRenderer.invoke('template:read', path),
  writeTemplateFile: (name, local, tpl) => ipcRenderer.invoke('template:write', name, local, tpl),
  exportTemplate: (name: string, local: boolean) =>
    ipcRenderer.invoke('template:export', name, local),
  applyTemplate: (path: string, mode: 'append' | 'replace') =>
    ipcRenderer.invoke('template:apply', path, mode),
  deleteTemplate: (path: string) => ipcRenderer.invoke('template:delete', path),

  listSnippets: () => ipcRenderer.invoke('snippet:list'),
  saveSnippet: (name: string, local: boolean, text: string) =>
    ipcRenderer.invoke('snippet:save', name, local, text),
  deleteSnippet: (path: string) => ipcRenderer.invoke('snippet:delete', path),

  modelCatalogs: (refresh?: boolean) => ipcRenderer.invoke('models:catalog', refresh),
  usageRead: (refresh?: boolean) => ipcRenderer.invoke('usage:read', refresh),
  graphList: () => ipcRenderer.invoke('graph:list'),
  graphCreate: (name: string) => ipcRenderer.invoke('graph:create', name),
  graphDelete: (id: string) => ipcRenderer.invoke('graph:delete', id),
  graphSave: (doc) => ipcRenderer.invoke('graph:save', doc),
  graphCompile: (graphId: string, nodeId: string) =>
    ipcRenderer.invoke('graph:compile', graphId, nodeId),
  graphInfer: (graphId, req) => ipcRenderer.invoke('graph:infer', graphId, req),
  graphDraftOpen: (draft) => ipcRenderer.invoke('graphDraft:open', draft),
  inboxHistory: () => ipcRenderer.invoke('inbox:history'),

  companionStart: () => ipcRenderer.invoke('companion:start'),
  companionStop: () => ipcRenderer.invoke('companion:stop'),
  companionStatus: () => ipcRenderer.invoke('companion:status'),
  companionDevices: () => ipcRenderer.invoke('companion:devices'),
  companionRevoke: (id: string) => ipcRenderer.invoke('companion:revoke', id),
  companionRevokeAll: () => ipcRenderer.invoke('companion:revoke-all'),
  onCompanionChanged: (cb) => subscribe('companion:changed', cb),
  onCompanionDeviceConnected: (cb) => subscribe('companion:device-connected', cb),

  onPtyData: (cb: (e: PtyDataEvent) => void) => onPtyDataMux(cb),
  onPtyExit: (cb: (e: PtyExitEvent) => void) => onPtyExitMux(cb),
  onSessionsChanged: (cb: (sessions: SessionRuntime[]) => void) =>
    subscribe('sessions:changed', cb),
  onSessionThinking: (cb: (e: SessionThinkingEvent) => void) =>
    subscribe('session:thinking', cb),
  onSessionQuota: (cb: (e: SessionQuotaEvent) => void) => subscribe('session:quota', cb),
  onSessionAttention: (cb: (e: SessionAttentionEvent) => void) =>
    subscribe('session:attention', cb),
  onInboxMessages: (cb: (messages: InboxMessage[]) => void) => subscribe('inbox:new', cb),
  onGraphDrafts: (cb) => subscribe('graphDrafts:update', cb),
  onInboxOpen: (cb: () => void) => subscribe('inbox:open', () => cb()),
  onFocusSession: (cb: (id: string) => void) => subscribe('session:focus', cb),
  onDesignPick: (cb: (event: DesignPickEvent) => void) => subscribe('design:pick', cb),
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
    subscribe('workspace:current', cb),
  onBrokerStatus: (cb: (status: BrokerStatusEvent) => void) => subscribe('broker:status', cb)
}

contextBridge.exposeInMainWorld('api', api)
