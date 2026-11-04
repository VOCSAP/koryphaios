// No electron runtime import (the type import is erased): loads under bun test.

import type { MenuItemConstructorOptions } from 'electron'

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
  onUseTemplate: () => void
  /** Opens the editor of the chosen template; spawns nothing. */
  onEditTemplate: () => void
  onSaveTemplate: () => void
}

/** Window-only events: never broadcast to a companion. */
export const MENU_CHANNELS = {
  settings: 'menu:settings',
  newClear: 'menu:new-clear',
  save: 'menu:save',
  saveAs: 'menu:save-as',
  restore: 'menu:restore',
  listWorkspaces: 'menu:list',
  useTemplate: 'menu:use-template',
  editTemplate: 'menu:edit-template',
  saveTemplate: 'menu:save-template'
} as const

/** Toggled live: Save Template is disabled while the Deck has no peer. */
export const SAVE_TEMPLATE_ITEM_ID = 'save-template'

export function rendererMenuActions(send: (channel: string) => void): AppMenuActions {
  return {
    onOpenSettings: () => send(MENU_CHANNELS.settings),
    onNewClear: () => send(MENU_CHANNELS.newClear),
    onSave: () => send(MENU_CHANNELS.save),
    onSaveAs: () => send(MENU_CHANNELS.saveAs),
    onRestore: () => send(MENU_CHANNELS.restore),
    onListWorkspaces: () => send(MENU_CHANNELS.listWorkspaces),
    onUseTemplate: () => send(MENU_CHANNELS.useTemplate),
    onEditTemplate: () => send(MENU_CHANNELS.editTemplate),
    onSaveTemplate: () => send(MENU_CHANNELS.saveTemplate)
  }
}

export interface AppMenuContext {
  isMac: boolean
  isDev: boolean
  appName: string
  label: (key: string) => string
  canSaveTemplate: boolean
}

export function appMenuTemplate(
  actions: AppMenuActions,
  { isMac, isDev, appName, label, canSaveTemplate }: AppMenuContext
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: appName,
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
    label: label('menu.file'),
    submenu: [
      { label: label('menu.newClear'), accelerator: 'CmdOrCtrl+Shift+N', click: actions.onNewClear },
      { type: 'separator' },
      { label: label('menu.save'), accelerator: 'CmdOrCtrl+S', click: actions.onSave },
      { label: label('menu.saveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: actions.onSaveAs },
      { label: label('menu.restore'), click: actions.onRestore },
      { label: label('menu.listWorkspaces'), click: actions.onListWorkspaces },
      { type: 'separator' },
      {
        label: label('menu.template'),
        submenu: [
          { label: label('menu.useTemplate'), click: actions.onUseTemplate },
          { label: label('menu.editTemplate'), click: actions.onEditTemplate },
          {
            id: SAVE_TEMPLATE_ITEM_ID,
            label: label('menu.saveTemplate'),
            enabled: canSaveTemplate,
            click: actions.onSaveTemplate
          }
        ]
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  })

  // No Undo/Redo/Cut/Select All: "Undo" would read as undoing the last prompt sent to a terminal.
  template.push({
    label: label('menu.edit'),
    submenu: [
      { label: label('menu.settings'), accelerator: 'CmdOrCtrl+,', click: actions.onOpenSettings },
      { type: 'separator' },
      { role: 'copy' },
      { role: 'paste' }
    ]
  })

  template.push({
    label: label('menu.view'),
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
    label: label('menu.window'),
    submenu: [{ role: 'minimize' }, { role: 'close' }]
  })

  return template
}
