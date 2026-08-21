// Custom application menu. The Electron default Edit menu (Undo / Redo / Cut /
// Copy / Paste / Select All) is misleading in a terminal app -- "Undo" reads as
// if it would undo the last prompt sent to a peer terminal. We keep only the
// clipboard ops that genuinely apply to an xterm selection (Copy / Paste) and a
// minimal View / Window, with DevTools exposed in development only.

import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export interface AppMenuActions {
  /** Open the in-app Settings page (Edit > Settings… / Ctrl+,). */
  onOpenSettings: () => void
  /** "New (clear)": close all sessions and return to the empty add-peers state. */
  onNewClear: () => void
  /** Save the current workspace (quick, keeps its name). */
  onSave: () => void
  /** Save the current workspace under a new name (prompt window). */
  onSaveAs: () => void
  /** Open the workspaces list to restore one. */
  onRestore: () => void
  /** Open the workspaces list. */
  onListWorkspaces: () => void
  /** Export the current sessions as a portable team template. */
  onExportTemplate: () => void
  /** Open the composer directly on a blank template (card 290a14e2). */
  onNewTemplate: () => void
  /** Open the template picker to instantiate a saved team. */
  onImportTemplate: () => void
}

export function buildAppMenu({
  onOpenSettings,
  onNewClear,
  onSave,
  onSaveAs,
  onRestore,
  onListWorkspaces,
  onExportTemplate,
  onNewTemplate,
  onImportTemplate
}: AppMenuActions): Menu {
  const isMac = process.platform === 'darwin'
  const isDev = !app.isPackaged

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New (clear)', accelerator: 'CmdOrCtrl+Shift+N', click: onNewClear },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: onSave },
      { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', click: onSaveAs },
      { label: 'Restore…', click: onRestore },
      { label: 'List workspaces', click: onListWorkspaces },
      { type: 'separator' },
      // Disabled until the Deck has at least one peer to export (toggled live
      // from index.ts on the session list changing).
      { id: 'export-template', label: 'Export template…', enabled: false, click: onExportTemplate },
      { label: 'New template…', click: onNewTemplate },
      { label: 'Import template…', click: onImportTemplate },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  })

  // Deliberately minimal: no Undo/Redo/Cut/Select All (confusing for terminals).
  // Settings lives here (Ctrl/Cmd+, is the standard accelerator) per the
  // operator's request to group all configuration under Edit.
  template.push({
    label: 'Edit',
    submenu: [
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: onOpenSettings },
      { type: 'separator' },
      { role: 'copy' },
      { role: 'paste' }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...(isDev ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    label: 'Window',
    submenu: [{ role: 'minimize' }, isMac ? { role: 'close' } : { role: 'close' }]
  })

  return Menu.buildFromTemplate(template)
}
