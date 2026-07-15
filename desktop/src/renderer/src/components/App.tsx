import { useEffect } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { Sidebar } from './Sidebar'
import { TileArea } from './TileArea'
import { DisplayModeBar } from './DisplayModeBar'
import { NavRail } from './NavRail'
import { RoadmapView } from './RoadmapView'
import { HomeView } from './HomeView'
import { HelpAssistant } from './HelpAssistant'
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
  const sidebarWidth = useDeck((s) => s.sidebarWidth)
  const view = useDeck((s) => s.view)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (config) document.documentElement.dataset.theme = config.theme
  }, [config])

  // Reflect the current workspace name in the window title.
  useEffect(() => {
    document.title = currentWorkspaceName
      ? `Claude Peers Deck — ${currentWorkspaceName}`
      : 'Claude Peers Deck'
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
        </div>
      </div>
      <div className={`view-home${view === 'home' ? '' : ' view-hidden'}`}>
        <HomeView active={view === 'home'} />
      </div>
      {view === 'roadmap' && <RoadmapView />}
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
      <HelpAssistant />
      <Toast />
    </div>
  )
}
