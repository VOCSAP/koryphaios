import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { AppConfig, CreateSessionInput, I18nPayload, LaunchConfig } from '@shared/types'
import type { SessionService } from './session-service'
import type { WorkspaceService } from './workspace-service'
import { listAgents } from './agents'
import { resolveLaunchConfig, saveGlobalConfig } from './launch-config'
import {
  listTemplates,
  readTemplate,
  writeTemplate,
  deleteTemplate,
  globalTemplatesDir,
  localTemplatesDir
} from './template-store'
import { toTemplate, templateToInputs } from '@shared/template'
import { availableLocales, loadDict, resolveLocale } from './i18n'

/**
 * Build the renderer i18n payload from the current config. Reads shipped locale
 * files (resources dir when packaged, app dir in dev) plus a user-override dir
 * under userData, then falls back to the embedded English base for any gap.
 */
function buildI18n(config: AppConfig): I18nPayload {
  const locale = resolveLocale(config.locale, app.getLocale())
  const shippedDir = app.isPackaged
    ? join(process.resourcesPath, 'locales')
    : join(app.getAppPath(), 'locales')
  const userDir = join(app.getPath('userData'), 'locales')
  const dirs = [shippedDir, userDir]
  return { locale, dict: loadDict(locale, dirs), available: availableLocales(dirs) }
}

interface IpcDeps {
  service: SessionService
  workspaces: WorkspaceService
  getConfig: () => AppConfig
  setConfig: (patch: Partial<AppConfig>) => AppConfig
  getWindow: () => BrowserWindow | null
  /** Broadcast a free-text operator message to the active group; returns peer count. */
  announce: (text: string) => Promise<number>
}

export function registerIpc({
  service,
  workspaces,
  getConfig,
  setConfig,
  getWindow,
  announce
}: IpcDeps): void {
  // ----- sessions -----
  ipcMain.handle('sessions:list', () => service.list())
  ipcMain.handle('sessions:create', (_e, input: CreateSessionInput) => service.create(input ?? {}))
  ipcMain.handle('sessions:remove', (_e, id: string) => service.remove(id))
  ipcMain.handle('sessions:rename', (_e, id: string, name: string) => service.rename(id, name))
  ipcMain.handle('sessions:set-color', (_e, id: string, color: string) =>
    service.setColor(id, color)
  )
  ipcMain.handle('sessions:restart', (_e, id: string) => service.restart(id))
  ipcMain.handle('sessions:set-auto-resume', (_e, id: string, enabled: boolean) =>
    service.setAutoResume(id, !!enabled)
  )
  ipcMain.handle('sessions:peek-next-color', () => service.peekNextColor())
  ipcMain.handle('sessions:reorder', (_e, ids: string[]) => service.reorder(ids ?? []))
  // "New (clear)": save+detach the current workspace (while sessions still
  // exist) THEN close all sessions, returning the window to the empty state.
  ipcMain.handle('app:new-clear', () => {
    workspaces.startNew()
    service.closeAll()
    getWindow()?.webContents.send('workspace:current', null)
  })

  // ----- pty io (fire-and-forget) -----
  ipcMain.on('pty:input', (_e, id: string, data: string) => service.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    service.resize(id, cols, rows)
  )

  // ----- config -----
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => setConfig(patch ?? {}))
  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getConfig().projectDir
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // ----- i18n -----
  ipcMain.handle('i18n:get', () => buildI18n(getConfig()))

  // ----- workspaces (persistence / restore) -----
  ipcMain.handle('workspace:list', () => workspaces.listForCwd())
  ipcMain.handle('workspace:save', (_e, name?: string) =>
    name && name.trim() ? workspaces.saveNamed(name) : workspaces.saveAuto()
  )
  ipcMain.handle('workspace:restore', (_e, id: string) => {
    const ok = workspaces.restore(id)
    if (ok) {
      const current = workspaces.listForCwd().find((w) => w.current) ?? null
      getWindow()?.webContents.send('workspace:current', current)
    }
    return ok
  })
  ipcMain.handle('workspace:delete', (_e, id: string) => workspaces.deleteWs(id))
  ipcMain.handle('workspace:current', () => workspaces.currentWorkspaceId)

  // ----- announce (outbound megaphone) -----
  ipcMain.handle('announce:send', (_e, text: string) => announce(text ?? ''))

  // ----- create-menu data -----
  ipcMain.handle('agents:list', () => listAgents(getConfig().projectDir))
  ipcMain.handle('launch:get', () => resolveLaunchConfig(getConfig().projectDir))
  ipcMain.handle('launch:set-global', (_e, cfg: LaunchConfig) => saveGlobalConfig(cfg))

  // ----- templates (portable team recipes) -----
  ipcMain.handle('template:list', () => listTemplates(getConfig().projectDir))
  ipcMain.handle('template:export', (_e, name: string, local: boolean) => {
    // captureSessions() carries cwd; toTemplate strips it (and id/sessionId).
    const tpl = toTemplate(service.captureSessions(), name)
    const dir = local ? localTemplatesDir(getConfig().projectDir) : globalTemplatesDir()
    return writeTemplate(dir, name || tpl.name || 'template', tpl)
  })
  ipcMain.handle('template:delete', (_e, path: string) =>
    deleteTemplate(path, getConfig().projectDir)
  )
  ipcMain.handle('template:apply', (_e, path: string, mode: 'append' | 'replace') => {
    const tpl = readTemplate(path)
    if (!tpl) return 0
    const inputs = templateToInputs(tpl)
    if (mode === 'replace') {
      // Detach + auto-save the current workspace, then clear (mirrors New clear).
      workspaces.startNew()
      service.closeAll()
      getWindow()?.webContents.send('workspace:current', null)
    }
    // Each peer spawns in this window's current project dir + group (no cwd in
    // the template); order is preserved by creation order.
    for (const input of inputs) service.create(input)
    return inputs.length
  })

  // ----- forward service events to the renderer -----
  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }
  service.on('data', (e) => send('pty:data', e))
  service.on('exit', (e) => send('pty:exit', e))
  service.on('changed', (sessions) => send('sessions:changed', sessions))
  service.on('thinking', (e) => send('session:thinking', e))
  service.on('quota', (e) => send('session:quota', e))
}
