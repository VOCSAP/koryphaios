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
//   DECK_CONTROL_TOOLS Optional ALLOW-list of tool names exposed via
//     tools/list (Card ff091064). Allow-list, never deny-list -- a deny-list
//     shrinking fails OPEN (a future tool ships exposed to everyone by
//     default, silently); an allow-list shrinking fails CLOSED (a forgotten
//     tool is refused, the symptom surfaces the same day). Semantics, all
//     three states meaningful and distinct:
//       unset            -> every tool (current behavior, zero regression
//                            for a caller that never sets this var).
//       set, non-empty   -> exactly the comma-separated names listed.
//       set, empty ("")  -> zero tools. Distinguishing "absent" from "empty"
//                            here is deliberate: without it, a bare
//                            `DECK_CONTROL_TOOLS=` declaration would be
//                            indistinguishable from "unset" and silently
//                            grant everything instead of nothing.

import { createInterface } from 'node:readline'

const CONTROL_URL = process.env.DECK_CONTROL_URL ?? ''
const CONTROL_TOKEN = process.env.DECK_CONTROL_TOKEN ?? ''
const TOOLS_ENV_VAR = 'DECK_CONTROL_TOOLS'

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

/** Shared spawn-entry schema (deck_spawn_session + deck_spawn_team members). */
const SPAWN_ENTRY_PROPS = {
  name: { type: 'string', description: 'Tile name (defaults to the agent/profile name).' },
  agent: AGENT_PROP,
  embedded_agent: {
    type: 'string',
    description:
      "Embedded fallback profile id from deck_team_agents (mutually exclusive with 'agent')."
  },
  model: { type: 'string', description: 'Model id from deck_list_models (omit for default).' },
  effort: {
    type: 'string',
    enum: ['low', 'medium', 'high', 'xhigh', 'max'],
    description: 'Reasoning effort (omit for default).'
  },
  cli: {
    type: 'string',
    enum: ['claude'],
    description: "Session CLI. Only 'claude' is supported for now (field reserved for multi-CLI)."
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
} as const

const TOOLS = [
  {
    name: 'deck_team_playbook',
    description:
      'The team-building playbook (fixed by the app): consent rule, roadmap/prompt decomposition, sizing, briefing and ack contracts. Read it BEFORE composing or spawning a team.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_team_agents',
    description:
      "Embedded fallback agent profiles (fixed by the app): id, role, recommended tier. Use one as embedded_agent when the operator's own base (deck_list_agents) lacks the role.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_spawn_team',
    description:
      'Spawn a whole team plan in ONE call (subject to the operator trust-mode setting). Returns immediately; the Deck then notifies you (targeted deck announce) as each session connects or fails to. Capped to 8 live sessions total.',
    inputSchema: {
      type: 'object',
      properties: {
        team: {
          type: 'array',
          description: 'One entry per session to spawn.',
          items: { type: 'object', properties: SPAWN_ENTRY_PROPS }
        }
      },
      required: ['team']
    }
  },
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
      'Spawn ONE visible Claude Code session tile in the Deck (subject to the operator trust-mode setting). By default the call waits for the session to connect and returns its peer_id (wait_for_peer:false returns immediately and the Deck notifies you instead). Optionally in a fresh git worktree. Capped to 8 live sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPAWN_ENTRY_PROPS,
        wait_for_peer: {
          type: 'boolean',
          description:
            'Default true: block until the peer_id resolves (90 s) and return it. false: return immediately; the Deck sends you a targeted notification when the session connects.'
        }
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
    name: 'deck_sandbox_exec',
    description:
      "Run a shell command inside THIS project's sandbox container (sandbox mode only) — e.g. install a dependency the agents need. Runs as the container user in /work, times out after 5 min, returns {code, stdout, stderr} (clipped). Fails when sandbox mode is off for the project.",
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command, e.g. "bun add zod".' }
      },
      required: ['command']
    }
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

/**
 * Pure allow-list resolver for DECK_CONTROL_TOOLS. `undefined` (env var
 * absent) means "no restriction" -- distinct from `[]` (env var present and
 * empty, meaning zero tools). See the env-contract comment above for the
 * full semantics; kept pure so a test can drive it without spawning a
 * process or touching env.
 */
function resolveToolAllowlist(envValue: string | undefined): string[] | null {
  if (envValue === undefined) return null
  if (envValue === '') return []
  return envValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Pure filter: `null` allowlist (var absent) passes every tool through unchanged. */
function filterTools(tools: typeof TOOLS, allowlist: string[] | null): typeof TOOLS {
  if (allowlist === null) return tools
  const allowed = new Set(allowlist)
  return tools.filter((t) => allowed.has(t.name))
}

const TOOLS_ALLOWLIST_RAW = process.env[TOOLS_ENV_VAR]
const TOOLS_ALLOWLIST = resolveToolAllowlist(TOOLS_ALLOWLIST_RAW)
const FILTERED_TOOLS = filterTools(TOOLS, TOOLS_ALLOWLIST)

// Resolution trace at startup (Card ff091064): when a tool is missing from a
// caller's surface, this is what says whether DECK_CONTROL_TOOLS ate it and
// what the requested vs retained lists were -- without it, diagnosing a
// missing tool costs an hour of guessing between this filter and the
// definition's own `tools:` frontmatter (a second, independent filter).
// stdout is the JSON-RPC channel here (never console.log); stderr is the
// only sink this dependency-free script has.
process.stderr.write(
  JSON.stringify({
    ev: 'deck-control-mcp: tool allowlist resolved',
    source: TOOLS_ALLOWLIST_RAW === undefined ? 'unset (no restriction)' : TOOLS_ENV_VAR,
    requested: TOOLS_ALLOWLIST,
    retained: FILTERED_TOOLS.map((t) => t.name)
  }) + '\n'
)

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
        serverInfo: { name: 'deck-control', version: '0.6.0' },
        instructions:
          'You are the Deck SUPERVISOR. You pilot the desktop app that hosts this session: spawn visible agent sessions (deck_spawn_session for one, deck_spawn_team for a whole plan, with agent profiles from deck_list_agents or embedded fallbacks from deck_team_agents, initial prompts, optional worktrees), inspect them (deck_list_sessions), manage worktrees and templates, and broadcast announcements. You do NOT write code yourself: read the project, consult the shared roadmap (roadmap_* tools), pick the right agent profiles, brief them via the initial prompt, then coordinate through send_message / list_peers. CONSENT: never spawn without an explicit operator instruction in the conversation — a question calls for a proposal plus confirmation; read deck_team_playbook before composing a team. Destructive actions only work on what you created; ask the operator otherwise.'
      })
    case 'ping':
      return reply(req.id, {})
    case 'tools/list':
      return reply(req.id, { tools: FILTERED_TOOLS })
    case 'tools/call': {
      const name = req.params?.name as string
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      // Coverage, not just sensitivity (CLAUDE.md guard-coverage rule): hiding
      // a tool from tools/list alone still leaves it CALLABLE by name, which
      // would make the allow-list decorative. Refuse here too, so the deny
      // is enforced at the boundary that actually reaches deck-control.ts,
      // not only at discovery time.
      if (!FILTERED_TOOLS.some((t) => t.name === name)) {
        return reply(req.id, {
          content: [{ type: 'text', text: `Error: tool not available: ${name}` }],
          isError: true
        })
      }
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
