import { join } from 'node:path'
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, webContents } from 'electron'
import type {
  AppConfig,
  CreateSessionInput,
  DispatchResult,
  HelpExchange,
  I18nPayload,
  LaunchConfig,
  RoadmapListFilters,
  RoadmapUpsertFields,
  SessionRuntime
} from '@shared/types'
import { APP_STATE_SUBDIR } from './migrate-data-dir'
import {
  buildHelpCommand,
  buildHelpPrompt,
  runHelp,
  writeHelpSystemPrompt
} from './help-assistant'
import { buildWandPrompt, WAND_MODEL, writeWandSystemPrompt, type WandDraft } from './context-wand'
import { resolveBrokerEndpoint } from './broker-client'
import {
  buildDigestSystemPrompt,
  collectSources,
  DIGEST_PROMPT,
  readDigestConfig,
  sourcesForProject
} from './digest'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { archiveRoadmap, computeDeckProjectKey, listRoadmap, upsertRoadmap } from './roadmap-service'
import { createSessionWithWorktree } from './create-session'
import { composePlanImportPrompt } from './import-plan'
import { collectDiff, composeDiffReviewPrompt } from './diff-service'
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  runWorktreeInit,
  worktreeStatus
} from './worktree-service'
import { resolve as resolvePath } from 'node:path'
import type { SessionService } from './session-service'
import type { WorkspaceService } from './workspace-service'
import type { Journal, JournalKind } from './journal'
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
import {
  deleteSnippet,
  globalSnippetsDir,
  listSnippets,
  localSnippetsDir,
  writeSnippet
} from './snippet-store'
import { deleteGraph, loadGraphs, upsertGraph } from './graph-store'
import { getCatalogs } from './model-registry'
import { compileContext, runInference, type InferRequest } from './graph-engine'
import { graphId as graphDocId, parseGraphDoc, type GraphDoc } from '../shared/graph'
import { parseTemplate, toTemplate, templateToInputs } from '@shared/template'
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
  /** Spawn (or return) the Home supervisor session (PLAN C5). */
  ensureSupervisor: () => Promise<SessionRuntime>
  /** Activity journal (PLAN C14), owned by index.ts. */
  journal: Journal
  /** Dispatch the first queued roadmap item to the team-lead (PLAN C15). */
  dispatchNext: () => Promise<DispatchResult>
  /** Git checkpoint of a dirty tree before an agent spawns there (PLAN C16). */
  checkpoint: (dir: string) => Promise<void>
}

export function registerIpc({
  service,
  workspaces,
  getConfig,
  setConfig,
  getWindow,
  announce,
  ensureSupervisor,
  journal,
  dispatchNext,
  checkpoint
}: IpcDeps): void {
  // ----- sessions -----
  ipcMain.handle('sessions:list', () => service.list())
  // Worktree handling (PLAN C4) lives in the shared create path, also used by
  // the supervisor's deck-control spawn.
  ipcMain.handle('sessions:create', (_e, input: CreateSessionInput) =>
    createSessionWithWorktree(service, getConfig().projectDir, input ?? {}, checkpoint)
  )
  ipcMain.handle('sessions:remove', (_e, id: string) => service.remove(id))
  ipcMain.handle('sessions:rename', (_e, id: string, name: string) => service.rename(id, name))
  ipcMain.handle('sessions:set-color', (_e, id: string, color: string) =>
    service.setColor(id, color)
  )
  ipcMain.handle('sessions:restart', (_e, id: string) => service.restart(id))
  ipcMain.handle('sessions:set-auto-resume', (_e, id: string, enabled: boolean) =>
    service.setAutoResume(id, !!enabled)
  )
  ipcMain.handle('sessions:set-lead', (_e, id: string) => service.setLead(id))
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

  // ----- embedded browser (PLAN D1) -----
  // Absolute path of the guest preload injected into the <webview>. Built as a
  // second preload entry (electron.vite.config.ts) next to index.js.
  ipcMain.handle('browser:preload-path', () => join(__dirname, '../preload/browser-inspect.js'))

  // Screenshot of the browser <webview> (draw mode, D1). The id must belong to
  // a webview hosted by OUR window — never an arbitrary webContents.
  ipcMain.handle('browser:capture', async (_e, id: number) => {
    const win = getWindow()
    const wc = typeof id === 'number' ? webContents.fromId(id) : undefined
    if (!win || !wc || wc.hostWebContents !== win.webContents) return null
    try {
      const img = await wc.capturePage()
      return img.toDataURL()
    } catch {
      return null
    }
  })

  // ----- window mirror (PLAN D2a) -----
  // List capturable OS windows/screens for the browser view's Window mode.
  // Thumbnails small on purpose: the picker only needs recognizable previews.
  ipcMain.handle('design:list-windows', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false
    })
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
  })

  // Full-size still of one source. desktopCapturer's thumbnail IS the capture:
  // requesting a large bounding box yields a native-resolution, aspect-true
  // image without opening a getUserMedia stream (a still is also what the
  // annotation flow wants — the page can't move under the strokes).
  ipcMain.handle('design:capture-window', async (_e, id: string) => {
    if (typeof id !== 'string' || !id) return null
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 4096, height: 4096 },
      fetchWindowIcons: false
    })
    const src = sources.find((s) => s.id === id)
    if (!src || src.thumbnail.isEmpty()) return null
    return { dataUrl: src.thumbnail.toDataURL(), title: src.name }
  })

  // Persist an annotated screenshot (page capture + operator strokes,
  // composited renderer-side) so the docked agent can Read the image file.
  // Kept under app state, pruned after 7 days (same policy as checkpoints).
  ipcMain.handle('browser:save-annotation', (_e, dataUrl: string) => {
    const PREFIX = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) return null
    const b64 = dataUrl.slice(PREFIX.length)
    if (b64.length > 48 * 1024 * 1024) return null // ~36 MB decoded, plenty
    const dir = join(app.getPath('userData'), APP_STATE_SUBDIR, 'annotations')
    try {
      mkdirSync(dir, { recursive: true })
      for (const f of readdirSync(dir)) {
        try {
          const p = join(dir, f)
          if (Date.now() - statSync(p).mtimeMs > 7 * 86_400_000) rmSync(p)
        } catch {
          /* concurrent cleanup */
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const path = join(dir, `annotation-${stamp}.png`)
      writeFileSync(path, Buffer.from(b64, 'base64'))
      return path
    } catch (err) {
      console.error('[browser] annotation save failed:', err)
      return null
    }
  })

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

  // ----- roadmap (shared per-project backlog, PLAN C3) -----
  // Endpoint + project key are resolved per call: cheap (config file read + one
  // git exec) and always consistent with the current projectDir. Operator
  // writes are stamped by='deck' inside roadmap-service.
  const roadmapCtx = (): { endpoint: ReturnType<typeof resolveBrokerEndpoint>; key: string } => ({
    endpoint: resolveBrokerEndpoint(),
    key: computeDeckProjectKey(getConfig().projectDir)
  })
  ipcMain.handle('roadmap:list', (_e, filters: RoadmapListFilters) => {
    const { endpoint, key } = roadmapCtx()
    return listRoadmap(endpoint, key, filters ?? {})
  })
  ipcMain.handle('roadmap:upsert', (_e, fields: RoadmapUpsertFields) => {
    const { endpoint, key } = roadmapCtx()
    return upsertRoadmap(endpoint, key, fields ?? {})
  })
  ipcMain.handle('roadmap:archive', (_e, id: string) => {
    const { endpoint } = roadmapCtx()
    return archiveRoadmap(endpoint, id)
  })
  // Queue dispatch (PLAN C15): first queued item -> targeted announce to the
  // team-lead. The renderer greys the button when no lead is designated.
  ipcMain.handle('roadmap:dispatch', () => dispatchNext())
  // Context wand (PLAN C21): one read-only `claude -p` (haiku, C9 harness)
  // drafts the item's context field grounded in the project files. The result
  // only fills the editor textarea -- saving stays an explicit operator action.
  ipcMain.handle('roadmap:wand', (_e, draft: WandDraft) => {
    const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)
    const command = buildHelpCommand({
      promptText: buildWandPrompt(draft ?? { title: '', kind: '', description: '', rationale: '', context: '' }),
      systemPromptFile: writeWandSystemPrompt(stateDir),
      model: WAND_MODEL
    })
    return runHelp({ command, shell: getConfig().shell, cwd: getConfig().projectDir })
  })

  // ----- worktrees (PLAN C4/C6) -----
  ipcMain.handle('worktree:remove', async (_e, path: string) => {
    await removeWorktree(getConfig().projectDir, path)
    journal.add('worktree', `worktree removed: ${path}`)
  })
  ipcMain.handle('worktree:list', async () => {
    const worktrees = await listWorktrees(getConfig().projectDir)
    const sessions = service.list().filter((s) => s.status !== 'exited')
    return Promise.all(
      worktrees.map(async (w) => {
        const status = await worktreeStatus(w.path)
        const attached = sessions.find(
          (s) => s.worktree?.path === w.path || resolvePath(s.cwd) === w.path
        )
        return {
          ...w,
          ...status,
          sessionId: attached?.id ?? null,
          sessionName: attached?.name ?? null
        }
      })
    )
  })
  ipcMain.handle('worktree:create', async (_e, branch: string) => {
    const wt = await createWorktree(getConfig().projectDir, branch ?? '')
    const init = resolveLaunchConfig(getConfig().projectDir).worktreeInit
    if (init) runWorktreeInit(wt.path, init)
    journal.add('worktree', `worktree created on ⎇ ${wt.branch}`)
  })

  // ----- diff / review (PLAN C13) -----
  // Base resolution: a NON-MAIN worktree of the project is compared to the
  // main worktree's branch (merge-base); anything else (main tree, foreign
  // cwd) gets uncommitted-only. Never guessed from config.
  const diffBase = async (dir: string): Promise<string | null> => {
    try {
      const all = await listWorktrees(getConfig().projectDir)
      const main = all.find((w) => w.main)
      const target = all.find((w) => w.path === resolvePath(dir))
      if (!main?.branch || !target || target.main) return null
      return main.branch
    } catch {
      return null
    }
  }
  ipcMain.handle('diff:collect', async (_e, dir: string) =>
    collectDiff(dir, await diffBase(dir))
  )
  // One-shot review agent (C7 pattern, code-constant prompt): reads the diff
  // in place and reports to the team-lead peer (C10) when one is live.
  ipcMain.handle('diff:review', async (_e, dir: string) => {
    const lead =
      service.list().find((s) => s.lead && s.status !== 'exited' && s.peerId)?.peerId ?? null
    await createSessionWithWorktree(
      service,
      getConfig().projectDir,
      {
        name: 'reviewer',
        cwd: dir,
        prompt: composeDiffReviewPrompt({ dir, base: await diffBase(dir), leadPeerId: lead }),
        announce: `one-shot reviewer: reviews the diff in "${dir}"`
      },
      checkpoint
    )
    journal.add('review', `review agent spawned on ${dir}${lead ? ` (reports to ${lead})` : ''}`)
    return true
  })

  // ----- activity journal (PLAN C14) -----
  ipcMain.handle('journal:list', (_e, kind?: string | null) =>
    journal.list((kind as JournalKind) || null)
  )
  // Plain-text export via a save dialog; returns the written path or null.
  ipcMain.handle('journal:export', async () => {
    const win = getWindow()
    const res = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: join(getConfig().projectDir, 'deck-journal.txt'),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return null
    const { writeFileSync } = await import('node:fs')
    writeFileSync(res.filePath, journal.toText() + '\n', 'utf-8')
    return res.filePath
  })

  // ----- supervisor (PLAN C5) -----
  ipcMain.handle('supervisor:ensure', () => ensureSupervisor())

  // ----- plan import (PLAN C7) -----
  // File picker + one-shot import agent (code-constant prompt). Returns true
  // when an agent was spawned, false when the picker was cancelled.
  ipcMain.handle('roadmap:import-plan', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      defaultPath: getConfig().projectDir,
      filters: [
        { name: 'Plans', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const file = res.canceled ? null : (res.filePaths[0] ?? null)
    if (!file) return false
    await createSessionWithWorktree(
      service,
      getConfig().projectDir,
      {
        name: 'plan-import',
        prompt: composePlanImportPrompt(file),
        announce: `one-shot agent: imports plan "${file}" into the shared roadmap`
      },
      checkpoint
    )
    return true
  })

  // ----- help assistant (PLAN C9) -----
  // One throwaway `claude -p` per question: no MCP (--strict-mcp-config), no
  // mutating tools. The assistant does NOT need tools to know the app state:
  // the snapshot below is composed by the app (same broker/git reads the views
  // use) and injected into the system prompt. It covers ALL views, not just
  // the active one, so a roadmap question asked from the Agents view is still
  // grounded; each part degrades to an error note instead of failing the call.
  const helpSnapshot = async (): Promise<unknown> => {
    const part = async <T>(fn: () => T | Promise<T>): Promise<T | { error: string }> => {
      try {
        return await fn()
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    const [roadmap, worktrees] = await Promise.all([
      part(async () => {
        const { endpoint, key } = roadmapCtx()
        const items = await listRoadmap(endpoint, key, {})
        return items.map((i) => ({
          id: i.id.slice(0, 8),
          title: i.title,
          kind: i.kind,
          priority: i.priority,
          value: i.value,
          effort: i.effort,
          status: i.status,
          tags: i.tags,
          description: i.description.slice(0, 300),
          context: i.context.slice(0, 300)
        }))
      }),
      part(() => listWorktrees(getConfig().projectDir))
    ])
    const sessions = await part(() =>
      service.list().map((s) => ({
        name: s.name,
        peer_id: s.peerId,
        status: s.status,
        thinking: s.thinking,
        rate_limited: s.rateLimited,
        cwd: s.cwd,
        worktree_branch: s.worktree?.branch ?? null,
        supervisor: !!s.supervisor
      }))
    )
    return { roadmap_items: roadmap, sessions, git_worktrees: worktrees }
  }
  ipcMain.handle(
    'help:ask',
    async (_e, question: string, view: string, transcript: HelpExchange[]) => {
      const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)
      const systemPromptFile = writeHelpSystemPrompt(stateDir, {
        view,
        data: await helpSnapshot()
      })
      const command = buildHelpCommand({
        promptText: buildHelpPrompt(question ?? '', transcript ?? []),
        systemPromptFile,
        model: getConfig().helpModel
      })
      return runHelp({ command, shell: getConfig().shell, cwd: getConfig().projectDir })
    }
  )

  // ----- resume digest (PLAN C17) -----
  // Same read-only `claude -p` harness as help:ask, with the app snapshot PLUS
  // the configured project sources. Sources come from the GLOBAL config only
  // (readDigestConfig has no projectDir input by design — a repo-carried
  // command list would execute arbitrary code on clone); commands still run
  // with cwd = projectDir so generic sources adapt per project.
  ipcMain.handle('help:digest', async () => {
    const projectDir = getConfig().projectDir
    const cfg = readDigestConfig()
    const { key } = roadmapCtx()
    const sources = await collectSources(sourcesForProject(cfg, key), projectDir)
    const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)
    mkdirSync(stateDir, { recursive: true })
    const systemPromptFile = join(stateDir, 'digest-system-prompt.md')
    writeFileSync(
      systemPromptFile,
      buildDigestSystemPrompt({
        locale: resolveLocale(getConfig().locale, app.getLocale()),
        data: await helpSnapshot(),
        sources
      }),
      'utf-8'
    )
    const command = buildHelpCommand({
      promptText: DIGEST_PROMPT,
      systemPromptFile,
      model: getConfig().helpModel
    })
    return runHelp({ command, shell: getConfig().shell, cwd: projectDir })
  })

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
  ipcMain.handle('template:apply', async (_e, path: string, mode: 'append' | 'replace') => {
    const tpl = readTemplate(path)
    if (!tpl) return 0
    const inputs = templateToInputs(tpl)
    // One checkpoint covers the batch: every session spawns in the project dir.
    if (inputs.length > 0) await checkpoint(getConfig().projectDir)
    if (mode === 'replace') {
      // Detach + auto-save the current workspace, then clear (mirrors New clear).
      workspaces.startNew()
      service.closeAll()
      getWindow()?.webContents.send('workspace:current', null)
    }
    // The template's lead becomes the window's ONLY when no lead exists yet
    // (PLAN C18) — applying a team must not silently steal the crown.
    const hasLead = service.list().some((s) => s.lead && s.status !== 'exited')
    // Each peer spawns in this window's current project dir + group (no cwd in
    // the template); order is preserved by creation order. Routed through the
    // worktree-aware path so composer templates with worktreeBranch work.
    for (const input of inputs) {
      await createSessionWithWorktree(
        service,
        getConfig().projectDir,
        hasLead ? { ...input, lead: undefined } : input
      )
    }
    return inputs.length
  })

  // ----- snippets (reusable prompts, PLAN C22) -----
  // Fill-not-send: the renderer pastes the text into a session's input field;
  // the main process only stores/lists .md files (project > global scope).
  ipcMain.handle('snippet:list', () => listSnippets(getConfig().projectDir))
  ipcMain.handle('snippet:save', (_e, name: string, local: boolean, text: string) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('snippet name is required')
    if (typeof text !== 'string' || !text.trim()) throw new Error('snippet text is required')
    const dir = local ? localSnippetsDir(getConfig().projectDir) : globalSnippetsDir()
    return writeSnippet(dir, name, text)
  })
  ipcMain.handle('snippet:delete', (_e, path: string) =>
    deleteSnippet(path, getConfig().projectDir)
  )

  // ----- graph chat (EXPLORATION-graph-chat C23-C27) -----
  // Desktop-local per-project persistence (D7); inference = stateless headless
  // fan-out (D1), context recompiled from the graph on every call.
  const graphCtx = (): { stateDir: string; key: string } => ({
    stateDir: join(app.getPath('userData'), APP_STATE_SUBDIR),
    key: computeDeckProjectKey(getConfig().projectDir)
  })
  // Model catalogs for the pickers (C29): frontier CLIs detected through the
  // login shell (cached for the app run), local endpoints discovered live.
  ipcMain.handle('models:catalog', (_e, refresh?: boolean) =>
    getCatalogs(getConfig().localProviders ?? [], getConfig().shell, { refresh: !!refresh })
  )

  ipcMain.handle('graph:list', () => {
    const { stateDir, key } = graphCtx()
    return loadGraphs(stateDir, key)
  })
  ipcMain.handle('graph:create', (_e, name: string) => {
    const { stateDir, key } = graphCtx()
    const doc: GraphDoc = {
      id: graphDocId(),
      name: (typeof name === 'string' && name.trim()) || 'graph',
      nodes: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    return upsertGraph(stateDir, key, doc)
  })
  ipcMain.handle('graph:delete', (_e, id: string) => {
    const { stateDir, key } = graphCtx()
    return deleteGraph(stateDir, key, id)
  })
  ipcMain.handle('graph:save', (_e, raw: unknown) => {
    const doc = parseGraphDoc(raw)
    if (!doc) return null
    const { stateDir, key } = graphCtx()
    return upsertGraph(stateDir, key, doc)
  })
  ipcMain.handle('graph:compile', (_e, graphId: string, nodeId: string) => {
    const { stateDir, key } = graphCtx()
    const doc = loadGraphs(stateDir, key).find((d) => d.id === graphId)
    if (!doc) throw new Error('unknown graph')
    return compileContext(doc, nodeId)
  })
  ipcMain.handle('graph:infer', async (_e, graphId: string, req: InferRequest) => {
    const { stateDir, key } = graphCtx()
    // Re-read from disk: the renderer may have saved node moves meanwhile.
    const doc = loadGraphs(stateDir, key).find((d) => d.id === graphId)
    if (!doc) throw new Error('unknown graph')
    const updated = await runInference(
      {
        stateDir,
        shell: getConfig().shell,
        cwd: getConfig().projectDir,
        localProviders: getConfig().localProviders ?? []
      },
      doc,
      req ?? ({} as InferRequest)
    )
    journal.add('graph', `graph inference on ${req.nodeId} (${req.targets?.length ?? 0} target(s)${req.battle ? ', battle' : ''})`)
    return upsertGraph(stateDir, key, updated)
  })

  // ----- template composer (PLAN C18): read/write without spawning -----
  ipcMain.handle('template:read', (_e, path: string) => readTemplate(path))
  ipcMain.handle('template:write', (_e, name: string, local: boolean, tpl: unknown) => {
    // parseTemplate validates the shape AND normalizes lead uniqueness.
    const parsed = parseTemplate(tpl)
    if (!parsed) throw new Error('invalid template')
    if (name && name.trim()) parsed.name = name.trim()
    const dir = local ? localTemplatesDir(getConfig().projectDir) : globalTemplatesDir()
    return writeTemplate(dir, name || parsed.name || 'template', parsed)
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
  service.on('attention', (e) => send('session:attention', e))
}
