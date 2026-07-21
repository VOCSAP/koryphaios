import { useEffect, useRef } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { Sidebar } from './Sidebar'
import { TileArea } from './TileArea'
import { DisplayModeBar } from './DisplayModeBar'
import { NavRail } from './NavRail'
import { RoadmapView } from './RoadmapView'
import { GitView } from './GitView'
import { GraphView } from './GraphView'
import { WorktreesView } from './WorktreesView'
import { JournalView } from './JournalView'
import { HomeView } from './HomeView'
import { BrowserView } from './BrowserView'
import { HelpAssistant } from './HelpAssistant'
import { InboxPanel } from './InboxPanel'
import { DiffPanel } from './DiffPanel'
import { SearchBar } from './SearchBar'
import { SettingsView } from './SettingsView'
import { WorkspacesDialog } from './WorkspacesDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { Toast } from './Toast'
import { SaveAsDialog } from './SaveAsDialog'
import { TemplatesDialog } from './TemplatesDialog'
import { ExportTemplateDialog } from './ExportTemplateDialog'
import { ErrorBoundary } from './ErrorBoundary'
import { StatusBanner } from './StatusBanner'
import { CompanionDialog } from './CompanionDialog'
import { MobileNav } from './MobileNav'
import { MobileAgents } from './MobileAgents'
import { RoadmapList } from './RoadmapList'
import { retryRemoteConnection } from '../remote-api'
import { KeyBar } from './KeyBar'

/** Thin indirection so the mobile home view shares the agents key bar. */
function KeyBarForSession({ id }: { id: string }): React.JSX.Element {
  return <KeyBar sessionId={id} />
}

/** Companion link overlay (PLAN MB1/MB2): reconnecting curtain, and the
 * terminal "host disconnected" screen of the ephemeral session model. */
function RemoteLinkOverlay(): React.JSX.Element | null {
  const t = useT()
  const remote = useDeck((s) => s.remote)
  const remoteLink = useDeck((s) => s.remoteLink)
  if (!remote || remoteLink === 'connected' || remoteLink === null) return null
  return (
    <div className="remote-overlay" role="alert">
      {remoteLink === 'connecting' ? (
        <>
          <div className="remote-overlay-icon">📡</div>
          <h2>{t('companion.reconnecting')}</h2>
        </>
      ) : (
        <>
          <div className="remote-overlay-icon">🔌</div>
          <h2>{t('companion.hostGone')}</h2>
          <p>{t('companion.hostGoneHint')}</p>
          <button className="primary" onClick={() => retryRemoteConnection()}>
            {t('companion.retry')}
          </button>
        </>
      )}
    </div>
  )
}

export function App(): React.JSX.Element {
  const t = useT()
  const init = useDeck((s) => s.init)
  const config = useDeck((s) => s.config)
  const settingsOpen = useDeck((s) => s.settingsOpen)
  const workspacesOpen = useDeck((s) => s.workspacesOpen)
  const confirmNewClearOpen = useDeck((s) => s.confirmNewClearOpen)
  const openNewClearConfirm = useDeck((s) => s.openNewClearConfirm)
  const newClear = useDeck((s) => s.newClear)
  const saveAsOpen = useDeck((s) => s.saveAsOpen)
  const templatesOpen = useDeck((s) => s.templatesOpen)
  const exportTemplateOpen = useDeck((s) => s.exportTemplateOpen)
  const restoreLossId = useDeck((s) => s.restoreLossId)
  const confirmRestore = useDeck((s) => s.confirmRestore)
  const cancelRestore = useDeck((s) => s.cancelRestore)
  const currentWorkspaceName = useDeck((s) => s.currentWorkspaceName)
  const selectedId = useDeck((s) => s.selectedId)
  const maximizedId = useDeck((s) => s.maximizedId)
  const setMaximized = useDeck((s) => s.setMaximized)
  const searchOpen = useDeck((s) => s.searchOpen)
  const openSearch = useDeck((s) => s.openSearch)
  const sidebarWidth = useDeck((s) => s.sidebarWidth)
  const view = useDeck((s) => s.view)
  const browserOpened = useDeck((s) => s.browserOpened)
  const inboxOpen = useDeck((s) => s.inboxOpen)
  const initError = useDeck((s) => s.initError)
  const remote = useDeck((s) => s.remote)
  const mobile = useDeck((s) => s.mobile)
  const companionOpen = useDeck((s) => s.companionOpen)
  const supervisorId = useDeck((s) => s.sessions.find((x) => x.supervisor)?.id ?? null)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (config) document.documentElement.dataset.theme = config.theme
  }, [config])

  // Mobile derivation rule (PLAN MB3): the class only ever appears for a
  // remote coarse-pointer client — the Electron window keeps its exact
  // desktop rendering, whatever its size.
  useEffect(() => {
    document.documentElement.classList.toggle('is-mobile', mobile)
  }, [mobile])

  // Mobile keyboard/rotation (EXPLORATION §4): track the REAL visible height
  // so the pager + keybar shrink with the virtual keyboard; TerminalTile's
  // ResizeObserver then refits xterm for free.
  useEffect(() => {
    if (!mobile || !window.visualViewport) return
    const vv = window.visualViewport
    const apply = (): void => {
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    return () => vv.removeEventListener('resize', apply)
  }, [mobile])

  // Reflect the current workspace name in the window title.
  useEffect(() => {
    document.title = currentWorkspaceName
      ? `Koryphaios — ${currentWorkspaceName}`
      : 'Koryphaios'
  }, [currentWorkspaceName])

  // Ctrl+Shift+M toggles fullscreen of the selected tile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault()
        if (maximizedId) setMaximized(null)
        else if (selectedId) setMaximized(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, maximizedId, setMaximized])

  // External-app element picks (design endpoint, PLAN D2b): compose the same
  // prompt as the embedded browser's ⌖ and paste it into the docked agent
  // (else the selected one; else the clipboard). Lives here rather than in the
  // store to keep i18n out of it (store.ts and i18n.ts would import-cycle).
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => {
    return window.api.onDesignPick((event) => {
      const tt = tRef.current
      const { sessions, browserPairedId, selectedId, showToast } = useDeck.getState()
      const pick = event.pick
      const selector = pick.selectors[0]?.value ?? pick.tagName
      let prompt = event.source ? tt('design.sourcePrefix', { source: event.source }) : ''
      prompt += tt('browser.elementPrompt', {
        tag: pick.tagName,
        url: pick.pageUrl,
        selector,
        w: pick.width,
        h: pick.height
      })
      if (pick.text) prompt += tt('browser.elementPromptText', { text: pick.text })
      const target = [browserPairedId, selectedId]
        .map((id) => sessions.find((s) => s.id === id))
        .find((s) => s && s.status === 'running' && !s.supervisor)
      if (target) {
        window.api.ptyInput(target.id, `\x1b[200~${prompt}\x1b[201~`)
        showToast('toast.pickSent')
      } else {
        void navigator.clipboard.writeText(prompt)
        showToast('toast.pickCopied', 'info')
      }
    })
  }, [])

  // Ctrl+Shift+F toggles the cross-session search panel. Terminals swallow the
  // combo before the PTY sees it (TerminalTile's key handler) but let the DOM
  // event bubble up to this window-level listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openSearch(!searchOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchOpen, openSearch])

  if (!config) {
    // Bootstrap splash shown before init() resolves (config + locale dict load
    // together), so there is no dictionary to translate against yet -- which is
    // also why the failure text below is hardcoded bilingual (PLAN O4): a
    // broken i18n invoke is precisely one of the ways init() can fail.
    if (initError) {
      const fr = (navigator.language || '').toLowerCase().startsWith('fr')
      return (
        <div className="loading loading-error" role="alert">
          <h2>{fr ? 'Échec du démarrage' : 'Startup failed'}</h2>
          <p className="error-boundary-detail">{initError}</p>
          <button onClick={() => void init()}>{fr ? 'Réessayer' : 'Retry'}</button>
        </div>
      )
    }
    return <div className="loading" aria-busy="true" />
  }

  // Mobile shell (PLAN MB3): same views/stores/IPC, alternative chrome —
  // bottom tabs, pager, one-column roadmap. Presentation only, no fork.
  if (mobile) {
    return (
      <div className="app app-mobile">
        <StatusBanner />
        <RemoteLinkOverlay />
        <div className={`mview${view === 'agents' ? '' : ' view-hidden'}`}>
          <ErrorBoundary scope="agents">
            <MobileAgents />
          </ErrorBoundary>
        </div>
        <div className={`mview mview-home${view === 'home' ? '' : ' view-hidden'}`}>
          <ErrorBoundary scope="home">
            <HomeView active={view === 'home'} />
          </ErrorBoundary>
        </div>
        {view === 'home' && supervisorId && (
          <div className="mview-homekeys">
            {/* The supervisor terminal deserves the key bar too. */}
            <KeyBarForSession id={supervisorId} />
          </div>
        )}
        {view === 'roadmap' && (
          <ErrorBoundary scope="roadmap">
            <RoadmapList />
          </ErrorBoundary>
        )}
        {view === 'worktrees' && (
          <ErrorBoundary scope="worktrees">
            <WorktreesView />
          </ErrorBoundary>
        )}
        {view === 'journal' && (
          <ErrorBoundary scope="journal">
            <JournalView />
          </ErrorBoundary>
        )}
        {settingsOpen && (
          <ErrorBoundary scope="settings">
            <SettingsView />
          </ErrorBoundary>
        )}
        {inboxOpen && (
          <ErrorBoundary scope="inbox">
            <InboxPanel />
          </ErrorBoundary>
        )}
        <ErrorBoundary scope="diff">
          <DiffPanel />
        </ErrorBoundary>
        <MobileNav />
        <Toast />
      </div>
    )
  }

  return (
    <div className="app" style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}>
      {/* Fixed overlay (PLAN O5): shown while the broker is unreachable. */}
      <StatusBanner />
      <RemoteLinkOverlay />
      {companionOpen && !remote && <CompanionDialog />}
      <NavRail />
      {/* The agents and home views stay MOUNTED under the other views:
          unmounting TerminalTile would tear down the xterm instances and their
          scrollback. display:none keeps the PTYs and terminals alive. */}
      {/* Per-view boundaries (PLAN O4): the views are siblings of one tree, so
          a render crash in one must not unmount the others (terminals included). */}
      <div className={`view-agents${view === 'agents' ? '' : ' view-hidden'}`}>
        <ErrorBoundary scope="agents">
          <Sidebar />
          <div className="main-pane">
            <DisplayModeBar />
            <TileArea />
            <SearchBar />
          </div>
        </ErrorBoundary>
      </div>
      <div className={`view-home${view === 'home' ? '' : ' view-hidden'}`}>
        <ErrorBoundary scope="home">
          <HomeView active={view === 'home'} />
        </ErrorBoundary>
      </div>
      {/* Browser view (PLAN D1): mounted lazily on first open, then kept alive
          like agents/home — unmounting the <webview> would drop the page, and
          unmounting the dock terminal its xterm. */}
      {browserOpened && !remote && (
        <div className={`view-browser${view === 'browser' ? '' : ' view-hidden'}`}>
          <ErrorBoundary scope="browser">
            <BrowserView active={view === 'browser'} />
          </ErrorBoundary>
        </div>
      )}
      {view === 'git' && (
        <ErrorBoundary scope="git">
          <GitView />
        </ErrorBoundary>
      )}
      {view === 'roadmap' && (
        <ErrorBoundary scope="roadmap">
          <RoadmapView />
        </ErrorBoundary>
      )}
      {view === 'graph' && (
        <ErrorBoundary scope="graph">
          <GraphView />
        </ErrorBoundary>
      )}
      {view === 'worktrees' && (
        <ErrorBoundary scope="worktrees">
          <WorktreesView />
        </ErrorBoundary>
      )}
      {view === 'journal' && (
        <ErrorBoundary scope="journal">
          <JournalView />
        </ErrorBoundary>
      )}
      {settingsOpen && (
        <ErrorBoundary scope="settings">
          <SettingsView />
        </ErrorBoundary>
      )}
      {workspacesOpen && <WorkspacesDialog />}
      {saveAsOpen && <SaveAsDialog />}
      {templatesOpen && <TemplatesDialog />}
      {exportTemplateOpen && <ExportTemplateDialog />}
      {confirmNewClearOpen && (
        <ConfirmDialog
          title={t('confirm.newClearTitle')}
          message={t('confirm.newClearMessage')}
          confirmLabel={t('confirm.newClearConfirm')}
          onCancel={() => openNewClearConfirm(false)}
          onConfirm={() => void newClear()}
        />
      )}
      {restoreLossId && (
        <ConfirmDialog
          title={t('confirm.restoreLossTitle')}
          message={t('confirm.restoreLossMessage')}
          confirmLabel={t('workspaces.restore')}
          onCancel={cancelRestore}
          onConfirm={() => void confirmRestore()}
        />
      )}
      {inboxOpen && (
        <ErrorBoundary scope="inbox">
          <InboxPanel />
        </ErrorBoundary>
      )}
      <ErrorBoundary scope="diff">
        <DiffPanel />
      </ErrorBoundary>
      <ErrorBoundary scope="help">
        <HelpAssistant />
      </ErrorBoundary>
      <Toast />
    </div>
  )
}
