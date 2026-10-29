import { createInterface } from 'node:readline'
import { hostname } from 'node:os'
import { readSessionIdentityFile } from '../../shared/peer-cache.ts'
import { handleRoadmapDispatch, TOOLS_ALLOWLIST as PEERS_ALLOWLIST, type CompanionIdentity } from '../../shared/roadmap-dispatch.ts'
import { brokerHeaders, brokerUrl, loadBrokerConfig } from '../../shared/broker-config.ts'
import { DECK_CEILING_ENV, DECK_ROLE_ENV, resolveMountCeiling, resolveMountRole } from '../../shared/mount-ceiling.ts'
import { DIRECTIVE_ACCEPTS_PROMPT, directiveCommands } from '../src/main/directive'
import {
  CLEAR_RELOAD_WORKSTREAM_MAX,
  CLEAR_RELOAD_WORKSTREAM_RE,
  DIRECTIVE_MAX_TARGETS,
  DIRECTIVE_PROMPT_MAX
} from '../src/main/directive-run'

const CONTROL_URL = process.env.DECK_CONTROL_URL ?? ''
const CONTROL_TOKEN = process.env.DECK_CONTROL_TOKEN ?? ''
const brokerConfig = loadBrokerConfig((message) => process.stderr.write(`[claude-peers] ${message}\n`)).config
const ROADMAP_DISPATCH_ENDPOINT = {
  url: brokerUrl(brokerConfig),
  headers: brokerHeaders(brokerConfig, { 'Content-Type': 'application/json' })
}

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
      'Spawn a whole team plan in ONE call (subject to the operator trust-mode setting). Returns immediately; the Deck then notifies you (targeted deck announce) as each session connects or fails to. Operator caps live sessions.',
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
      'Spawn ONE visible Claude Code session tile in the Deck (subject to the operator trust-mode setting). By default the call waits for the session to connect and returns its peer_id (wait_for_peer:false returns immediately and the Deck notifies you instead). Optionally in a fresh git worktree. Operator caps live sessions.',
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
      'Close a session tile, named EITHER by its tile id OR by its peer_id -- exactly one of the two, never both, never neither (the call is refused otherwise, and a peer_id carried by no live tile or by several is refused too). A team-lead may close any non-locked peer except its own tile or a lead/supervisor tile. The supervisor may close any non-locked peer except supervisor tiles.',
    inputSchema: {
      type: 'object',
      // JSON Schema cannot express live-session resolution or authorization.
      properties: {
        id: { type: 'string', description: 'Tile id, e.g. from deck_spawn_session.' },
        peer_id: {
          type: 'string',
          description: 'Peer id of the tile, instead of id (must resolve to exactly one live tile).'
        }
      }
    }
  },
  {
    name: 'deck_close_all',
    description:
      'Close eligible session tiles while preserving locked and supervisor tiles; a team-lead also preserves lead tiles. Returns {closed, locked, failed, remaining}: names of the tiles closed, of the locked tiles left open (the operator closes those by hand), {name, error} for each closure that failed, and the names of tiles spawned during the call, left open. It does not land the peers first: send them their landing instruction before calling it.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deck_run_directive',
    description:
      'Run a directive on live peer tiles now, no card. clear is free, compact costs one inference, magic_compact uses the plugin, else compact. Result: injected = typed; refused = not typed (refused-modal|busy-timeout|no-terminal|error|context_resume_unsupported); pending = still queued; typed when the tile falls idle unless refused then (up to 120 s); do not resend; magic_compact is always pending; unreached = no single live tile carries that peer_id.',
    inputSchema: {
      type: 'object',
      properties: {
        directive: { type: 'string', enum: directiveCommands() },
        peer_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: DIRECTIVE_MAX_TARGETS,
          description: 'Target peer_ids, from list_peers.'
        },
        prompt: {
          type: 'string',
          maxLength: DIRECTIVE_PROMPT_MAX,
          description: `One line, max ${DIRECTIVE_PROMPT_MAX} code points, typed after the command. Only for: ${directiveCommands()
            .filter((d) => DIRECTIVE_ACCEPTS_PROMPT[d])
            .join(', ')}.`
        },
        workstream: {
          type: 'string',
          maxLength: CLEAR_RELOAD_WORKSTREAM_MAX,
          pattern: CLEAR_RELOAD_WORKSTREAM_RE.source,
          description: 'Required only for clear_reload; selects its fixed recovery instruction.'
        },
        context_deposit_id: {
          type: 'string',
          description:
            'clear_reload with one peer_id only: the deposit_id that peer deposited, pushed back after the clear; a team-lead needs it for any peer but itself. On context_resume_unsupported nothing was cleared: do not retry; ask the operator.'
        }
      },
      required: ['directive', 'peer_ids']
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
  },
  {
    name: 'roadmap_dispatch',
    description: "Run the roadmap queue's head wave in this Deck. It has no arguments.",
    inputSchema: { type: 'object', properties: {} }
  }
]

// The Deck writes the ceiling and the role into this entry's env; a missing or
// malformed one serves nothing. CLAUDE_PEERS_TOOLS only narrows roadmap_dispatch further.
const REGISTRY = TOOLS.map((t) => t.name)
const CEILING = resolveMountCeiling(DECK_CEILING_ENV, process.env[DECK_CEILING_ENV], REGISTRY)
const ROLE = resolveMountRole(process.env[DECK_ROLE_ENV])
const GRANTED = CEILING.ok && ROLE.ok ? CEILING.value : null
const FILTERED_TOOLS: typeof TOOLS =
  GRANTED === null
    ? []
    : TOOLS.filter((t) => GRANTED.includes(t.name)).filter(
        (t) => t.name !== 'roadmap_dispatch' || PEERS_ALLOWLIST === null || PEERS_ALLOWLIST.includes(t.name)
      )

const SUPERVISOR_INSTRUCTIONS =
  'You are the Deck SUPERVISOR. You pilot the desktop app that hosts this session: spawn visible agent sessions (deck_spawn_session for one, deck_spawn_team for a whole plan, with agent profiles from deck_list_agents or embedded fallbacks from deck_team_agents, initial prompts, optional worktrees), inspect them (deck_list_sessions), manage worktrees and templates, and broadcast announcements. You do NOT write code yourself: read the project, consult the shared roadmap (roadmap_* tools), pick the right agent profiles, brief them via the initial prompt, then coordinate through send_message / list_peers. CONSENT: never spawn without an explicit operator instruction in the conversation — a question calls for a proposal plus confirmation; read deck_team_playbook before composing a team. You may close any non-locked tile except supervisor tiles (deck_close_session, deck_close_all); other destructive actions only work on what you created, ask the operator otherwise.'

/** A lead's text names only the tools it is served. */
function subsetInstructions(toolNames: string[]): string {
  const closeRule = toolNames.includes('deck_close_session')
    ? ' deck_close_session closes any non-locked tile except your own and lead or supervisor tiles.'
    : ''
  return `You are a team-lead of this Deck, not its supervisor. Your Deck tools: ${toolNames.join(', ') || 'none'}.${closeRule}`
}

const INSTRUCTIONS =
  GRANTED === null
    ? 'No Deck tool is served: the mount ceiling is missing or invalid.'
    : ROLE.ok && ROLE.value === 'supervisor'
      ? SUPERVISOR_INSTRUCTIONS
      : subsetInstructions(FILTERED_TOOLS.map((t) => t.name))

// stdout is reserved for JSON-RPC frames, so diagnostics use stderr.
process.stderr.write(
  JSON.stringify(
    GRANTED === null
      ? {
          ev: 'deck-control-mcp: mount refused, no tool served',
          variable: !CEILING.ok ? DECK_CEILING_ENV : DECK_ROLE_ENV,
          reason: !CEILING.ok ? CEILING.reason : !ROLE.ok ? ROLE.reason : ''
        }
      : {
          ev: 'deck-control-mcp: mount ceiling resolved',
          role: ROLE.ok ? ROLE.value : null,
          registry: REGISTRY,
          retained: FILTERED_TOOLS.map((t) => t.name)
        }
  ) + '\n'
)

async function resolveCompanionIdentity(): Promise<CompanionIdentity> {
  const host = hostname()
  const deskSession = process.env.CLAUDE_PEERS_DESK_SESSION ?? ''
  const identity = deskSession ? await readSessionIdentityFile(deskSession) : null
  return {
    host,
    peerId: identity?.peerId ?? null,
    groupId: identity?.groupId ?? '',
    instanceToken: identity?.instanceToken ?? null,
    inboxBinding: identity?.inboxBinding ?? null,
    operatorId: identity?.operatorId ?? null,
    projectKey: '',
    fromPeer: identity?.peerId ?? `${host || 'unknown'}-unregistered`
  }
}

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
        instructions: INSTRUCTIONS
      })
    case 'ping':
      return reply(req.id, {})
    case 'tools/list':
      return reply(req.id, { tools: FILTERED_TOOLS })
    case 'tools/call': {
      const name = req.params?.name as string
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      if (!FILTERED_TOOLS.some((t) => t.name === name)) {
        return reply(req.id, {
          content: [{ type: 'text', text: `Error: tool not available: ${name}` }],
          isError: true
        })
      }
      try {
        if (name === 'roadmap_dispatch') {
          return reply(req.id, await handleRoadmapDispatch(await resolveCompanionIdentity(), ROADMAP_DISPATCH_ENDPOINT))
        }
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
