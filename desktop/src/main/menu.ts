import { app, Menu } from 'electron'
import { appMenuTemplate, type AppMenuActions } from './menu-template'

export function buildAppMenu(
  actions: AppMenuActions,
  label: (key: string) => string,
  canSaveTemplate: boolean
): Menu {
  return Menu.buildFromTemplate(
    appMenuTemplate(actions, {
      isMac: process.platform === 'darwin',
      isDev: !app.isPackaged,
      appName: app.name,
      label,
      canSaveTemplate
    })
  )
}
