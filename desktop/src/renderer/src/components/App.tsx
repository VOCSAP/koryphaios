import { useEffect, useRef } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { Sidebar } from './Sidebar'
import { TileArea } from './TileArea'
import { DisplayModeBar } from './DisplayModeBar'
import { NavRail } from './NavRail'
import { RoadmapView } from './RoadmapView'
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

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (config) document.documentElement.dataset.theme = config.theme
  }, [config])

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
    // together), so there is no dictionary to translate against yet.
    return <div className="loading" aria-busy="true" />
  }

  return (
    <div className="app" style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}>
      <NavRail />
      {/* The agents and home views stay MOUNTED under the other views:
          unmounting TerminalTile would tear down the xterm instances and their
          scrollback. display:none keeps the PTYs and terminals alive. */}
      <div className={`view-agents${view === 'agents' ? '' : ' view-hidden'}`}>
        <Sidebar />
        <div className="main-pane">
          <DisplayModeBar />
          <TileArea />
          <SearchBar />
        </div>
      </div>
      <div className={`view-home${view === 'home' ? '' : ' view-hidden'}`}>
        <HomeView active={view === 'home'} />
      </div>
      {/* Browser view (PLAN D1): mounted lazily on first open, then kept alive
          like agents/home — unmounting the <webview> would drop the page, and
          unmounting the dock terminal its xterm. */}
      {browserOpened && (
        <div className={`view-browser${view === 'browser' ? '' : ' view-hidden'}`}>
          <BrowserView active={view === 'browser'} />
        </div>
      )}
      {view === 'roadmap' && <RoadmapView />}
      {view === 'graph' && <GraphView />}
      {view === 'worktrees' && <WorktreesView />}
      {view === 'journal' && <JournalView />}
      {settingsOpen && <SettingsView />}
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
      {inboxOpen && <InboxPanel />}
      <DiffPanel />
      <HelpAssistant />
      <Toast />
    </div>
  )
}
