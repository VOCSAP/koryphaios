// Deck control endpoint (PLAN C5): a loopback HTTP server, started by the
// Electron main process, that lets the SUPERVISOR session pilot the app
// through the deck-control MCP server (desktop/mcp/deck-control-mcp.ts).
//
// Security model:
// - 127.0.0.1 only, random port, Bearer token minted per app launch. The pair
//   is injected ONLY into the supervisor tile's generated --mcp-config file,
//   never into normal agent sessions, project files or the shell env.
// - Destructive operations (close a session, remove a worktree) are allowed
//   only on objects the supervisor itself created through this endpoint;
//   anything else must go through the operator's UI.
// - A spawn cap keeps a runaway supervisor from flooding the window.
//
// The module is dependency-injected (no electron / node-pty imports) so the
// full dispatch + guard logic is unit-testable under `bun test`.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type {
  CreateSessionInput,
  LaunchPreset,
  ModelOption,
  SessionRuntime,
  TemplateSummary
} from '../shared/types'
import type { WorktreeInfo } from './worktree-service'

/** Live sessions cap enforced on deck_spawn_session. */
export const SPAWN_CAP = 8

export interface DeckControlDeps {
  listAgents(): string[]
  listModels(): ModelOption[]
  listPresets(): LaunchPreset[]
  /** Same path as the operator's create (worktree handling included). */
  spawnSession(input: CreateSessionInput): Promise<SessionRuntime>
  listSessions(): SessionRuntime[]
  restartSession(id: string): void
  closeSession(id: string): void
  createWorktree(branch: string): Promise<WorktreeInfo>
  listWorktrees(): Promise<WorktreeInfo[]>
  removeWorktree(path: string): Promise<void>
  listTemplates(): TemplateSummary[]
  /** Append-only from the supervisor ('replace' would kill its own tile). */
  applyTemplate(path: string): Promise<number>
  saveTemplate(name: string, local: boolean): string | null
  announce(text: string): Promise<number>
}

export interface DeckControlServer {
  url: string
  token: string
  close(): void
}

type ToolArgs = Record<string, unknown>

function str(args: ToolArgs, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** Trimmed session view exposed to the supervisor (no ids it must not need). */
function sessionView(s: SessionRuntime): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    peer_id: s.peerId,
    status: s.status,
    thinking: s.thinking,
    rate_limited: s.rateLimited,
    cwd: s.cwd,
    worktree_branch: s.worktree?.branch ?? null,
    supervisor: !!s.supervisor
  }
}

export function startDeckControl(
  deps: DeckControlDeps,
  opts: { port?: number } = {}
): Promise<DeckControlServer> {
  const token = randomBytes(24).toString('hex')
  // Objects created THROUGH this endpoint: the only ones destructive ops touch.
  const ownedSessions = new Set<string>()
  const ownedWorktrees = new Set<string>()

  async function dispatch(tool: string, args: ToolArgs): Promise<unknown> {
    switch (tool) {
      case 'deck_list_agents':
        return { agents: deps.listAgents() }
      case 'deck_list_models':
        return { models: deps.listModels() }
      case 'deck_list_presets':
        return { presets: deps.listPresets() }

      case 'deck_spawn_session': {
        const live = deps.listSessions().filter((s) => s.status !== 'exited').length
        if (live >= SPAWN_CAP) {
          throw new Error(`spawn cap reached (${SPAWN_CAP} live sessions) -- close one first`)
        }
        const created = await deps.spawnSession({
          name: str(args, 'name') || undefined,
          agent: str(args, 'agent') || undefined,
          model: str(args, 'model') || undefined,
          effort: str(args, 'effort') || undefined,
          args: str(args, 'args') || undefined,
          prompt: str(args, 'prompt') || undefined,
          worktreeBranch: str(args, 'worktree_branch') || undefined,
          announce: str(args, 'announce') || undefined
        })
        ownedSessions.add(created.id)
        if (created.worktree) ownedWorktrees.add(created.worktree.path)
        return { session: sessionView(created) }
      }

      case 'deck_list_sessions':
        return { sessions: deps.listSessions().map(sessionView) }

      case 'deck_restart_session': {
        const id = str(args, 'id')
        if (!id) throw new Error('id is required')
        deps.restartSession(id)
        return { ok: true }
      }

      case 'deck_close_session': {
        const id = str(args, 'id')
        if (!id) throw new Error('id is required')
        if (!ownedSessions.has(id)) {
          throw new Error(
            'refused: only sessions spawned by the supervisor can be closed -- ask the operator for the rest'
          )
        }
        deps.closeSession(id)
        ownedSessions.delete(id)
        return { ok: true }
      }

      case 'deck_create_worktree': {
        const branch = str(args, 'branch')
        if (!branch) throw new Error('branch is required')
        const wt = await deps.createWorktree(branch)
        ownedWorktrees.add(wt.path)
        return { worktree: wt }
      }

      case 'deck_list_worktrees':
        return { worktrees: await deps.listWorktrees() }

      case 'deck_remove_worktree': {
        const path = str(args, 'path')
        if (!path) throw new Error('path is required')
        if (!ownedWorktrees.has(path)) {
          throw new Error(
            'refused: only worktrees created by the supervisor can be removed -- ask the operator for the rest'
          )
        }
        await deps.removeWorktree(path) // git still refuses dirty trees (never forced)
        ownedWorktrees.delete(path)
        return { ok: true }
      }

      case 'deck_list_templates':
        return { templates: deps.listTemplates() }

      case 'deck_apply_template': {
        const path = str(args, 'path')
        if (!path) throw new Error('path is required')
        return { spawned: await deps.applyTemplate(path) }
      }

      case 'deck_save_template': {
        const name = str(args, 'name')
        if (!name) throw new Error('name is required')
        const saved = deps.saveTemplate(name, args['local'] === true)
        if (!saved) throw new Error('template save failed')
        return { path: saved }
      }

      case 'deck_announce': {
        const text = str(args, 'text')
        if (!text) throw new Error('text is required')
        return { sent: await deps.announce(text) }
      }

      default:
        throw new Error(`unknown tool: ${tool}`)
    }
  }

  const server: Server = createServer((req, res) => {
    const deny = (code: number, msg: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: msg }))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, 'unauthorized')
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.method !== 'POST' || req.url !== '/call') return deny(404, 'not found')

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024) req.destroy() // oversized payload
    })
    req.on('end', () => {
      void (async () => {
        try {
          const parsed = JSON.parse(body) as { tool?: string; args?: ToolArgs }
          if (!parsed.tool) return deny(400, 'tool is required')
          const result = await dispatch(parsed.tool, parsed.args ?? {})
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result }))
        } catch (e) {
          deny(400, e instanceof Error ? e.message : String(e))
        }
      })()
    })
  })

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('no address'))
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        token,
        close: () => server.close()
      })
    })
  })
}
