// deck-control MCP server (PLAN C5): the SUPERVISOR session's bridge to the
// Deck. A minimal, dependency-free MCP stdio server (newline-delimited
// JSON-RPC 2.0) that forwards every tool call to the Deck's loopback control
// endpoint (desktop/src/main/deck-control.ts).
//
// Runs under plain Node (packaged app: the Electron binary with
// ELECTRON_RUN_AS_NODE=1) -- node builtins + global fetch only, no
// @modelcontextprotocol/sdk, mirroring the desk-backchannel-hook build.
// Built by `npm run build:mcp` to deck-plugin/mcp/deck-control-mcp.mjs.
//
// Env contract (set in the generated --mcp-config file, per-server):
//   DECK_CONTROL_URL   http://127.0.0.1:<port>
//   DECK_CONTROL_TOKEN Bearer token minted per Deck launch

import { createInterface } from 'node:readline'

const CONTROL_URL = process.env.DECK_CONTROL_URL ?? ''
const CONTROL_TOKEN = process.env.DECK_CONTROL_TOKEN ?? ''

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

const AGENT_PROP = {
  type: 'string',
  description: 'Agent profile name from deck_list_agents (omit for none).'
} as const

const TOOLS = [
  {
    name: 'deck_list_agents',
    description:
      "List the agent profiles available on this machine (project .claude/agents + ~/.claude/agents). Use one as deck_spawn_session's agent.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_list_models',
    description: 'List the model choices configured for new sessions.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_list_presets',
    description: 'List the launch presets (label + args + optional prompt) configured for new sessions.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_spawn_session',
    description:
      'Spawn a new visible Claude Code session tile in the Deck (it joins this group: coordinate with it via send_message once its peer_id resolves). Optionally in a fresh git worktree. Capped to 8 live sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tile name (defaults to the agent name).' },
        agent: AGENT_PROP,
        model: { type: 'string', description: 'Model id from deck_list_models (omit for default).' },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Reasoning effort (omit for default).'
        },
        prompt: {
          type: 'string',
          description: 'Initial prompt submitted when the session opens (brief the agent here).'
        },
        worktree_branch: {
          type: 'string',
          description:
            'Create a fresh git worktree on this NEW branch under .worktrees/ and run the session in it.'
        },
        announce: { type: 'string', description: 'Join announcement broadcast to the group.' },
        args: { type: 'string', description: 'Extra claude CLI args, verbatim.' }
      }
    }
  },
  {
    name: 'deck_list_sessions',
    description:
      'List the Deck sessions (id, name, peer_id, status, thinking, rate_limited, cwd, worktree_branch).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_restart_session',
    description: 'Restart a session tile by id (fork-resumes its conversation).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'deck_close_session',
    description:
      'Close a session tile by id. Only sessions the supervisor spawned can be closed; the operator owns the rest.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'deck_create_worktree',
    description:
      'Create a git worktree under .worktrees/ on a NEW branch (one working dir per parallel agent).',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'New branch name, e.g. agent/fix-login.' } },
      required: ['branch']
    }
  },
  {
    name: 'deck_list_worktrees',
    description: 'List the git worktrees of the project (path, branch, main flag).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_remove_worktree',
    description:
      'Remove a worktree directory the supervisor created (branch always kept; git refuses dirty trees).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'deck_list_templates',
    description: 'List the saved team templates (recipes of sessions to spawn together).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_apply_template',
    description:
      'Spawn every session of a template (append to the current set; never replaces/closes existing tiles).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Template path from deck_list_templates.' } },
      required: ['path']
    }
  },
  {
    name: 'deck_save_template',
    description:
      'Save the current session set as a reusable template. local=true writes it into the project, else globally.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        local: { type: 'boolean', description: 'Write into the project dir (default false = global).' }
      },
      required: ['name']
    }
  },
  {
    name: 'deck_announce',
    description:
      "Broadcast a one-way, no-reply system message to every peer in this window's group (the Deck megaphone).",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  }
]

async function callControl(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${CONTROL_URL}/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CONTROL_TOKEN}`
    },
    body: JSON.stringify({ tool, args })
  })
  const parsed = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!parsed.ok) throw new Error(parsed.error ?? `control error ${res.status}`)
  return parsed.result
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case 'initialize':
      return reply(req.id, {
        protocolVersion:
          (req.params?.protocolVersion as string | undefined) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'deck-control', version: '0.5.0' },
        instructions:
          'You are the Deck SUPERVISOR. You pilot the desktop app that hosts this session: spawn visible agent sessions (deck_spawn_session, with agent profiles from deck_list_agents, initial prompts, optional worktrees), inspect them (deck_list_sessions), manage worktrees and templates, and broadcast announcements. You do NOT write code yourself: read the project, consult the shared roadmap (roadmap_* tools), pick the right agent profiles, brief them via the initial prompt, then coordinate through send_message / list_peers. Destructive actions only work on what you created; ask the operator otherwise.'
      })
    case 'ping':
      return reply(req.id, {})
    case 'tools/list':
      return reply(req.id, { tools: TOOLS })
    case 'tools/call': {
      const name = req.params?.name as string
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const result = await callControl(name, args)
        return reply(req.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        })
      } catch (e) {
        return reply(req.id, {
          content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true
        })
      }
    }
    default:
      // Notifications (no id) are ignored; unknown requests get an error back.
      if (req.id !== undefined && req.id !== null) {
        replyError(req.id, -32601, `method not found: ${req.method}`)
      }
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let req: JsonRpcRequest
  try {
    req = JSON.parse(text) as JsonRpcRequest
  } catch {
    return // skip malformed frames
  }
  void handle(req)
})
rl.on('close', () => process.exit(0))
