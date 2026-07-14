// Supervisor session support (PLAN C5): the generated --mcp-config file that
// bridges ONLY the Home supervisor tile to the deck-control endpoint, plus its
// built-in briefing prompt (submitted via the C2 initial-prompt mechanism).
//
// Node builtins only, unit-testable under `bun test`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Default tile name of the supervisor session. */
export const SUPERVISOR_NAME = 'supervisor'

/**
 * Built-in briefing, submitted as the supervisor's initial prompt. English,
 * like the MCP instructions. An operator-picked agent profile
 * (AppConfig.supervisorAgent) layers on top of this, never replaces it.
 */
export const SUPERVISOR_BRIEFING = [
  "You are this Deck window's SUPERVISOR. You pilot the desktop app hosting you; you do NOT write code yourself.",
  'Your levers: deck_* tools (spawn/inspect/close agent session tiles, worktrees, templates, announcements), roadmap_* tools (the shared per-project backlog), and the claude-peers messaging (list_peers / send_message) to coordinate the agents you spawn.',
  'Typical flow for a work request: survey the repository, check roadmap_list, pick agent profiles from deck_list_agents, create a worktree per independent work stream, spawn each agent with a precise briefing in its initial prompt, then follow up via send_message and keep the roadmap statuses current.',
  'Destructive deck actions only work on what you created; for anything else, ask the operator.',
  'Start now: introduce yourself in two sentences, run deck_list_agents and roadmap_list, summarize what you see, and ask the operator what to do.'
].join('\n\n')

export interface SupervisorMcpConfigInput {
  /** Directory the config file is written into (Deck app-state dir). */
  dir: string
  /** Absolute path of the built deck-control-mcp.mjs script. */
  mcpScriptPath: string
  /** Node-capable executable: the Electron binary (run as node) or plain node. */
  execPath: string
  controlUrl: string
  controlToken: string
}

/**
 * Write the supervisor's .mcp config file and return its path. Rewritten on
 * every supervisor spawn so the per-launch control URL/token stay current.
 * ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain node, so the
 * MCP server runs without any bundled runtime, packaged or dev.
 */
export function writeSupervisorMcpConfig(input: SupervisorMcpConfigInput): string {
  const config = {
    mcpServers: {
      'deck-control': {
        command: input.execPath,
        args: [input.mcpScriptPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DECK_CONTROL_URL: input.controlUrl,
          DECK_CONTROL_TOKEN: input.controlToken
        }
      }
    }
  }
  mkdirSync(input.dir, { recursive: true })
  const file = join(input.dir, 'supervisor-mcp.json')
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8')
  return file
}
