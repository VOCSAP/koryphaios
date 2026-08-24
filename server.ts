#!/usr/bin/env bun
/**
 * claude-peers MCP server (v0.9.0)
 *
 * Runs locally alongside Claude Code. Always uses local context detection --
 * SSH mode is removed in v0.3.1.
 *
 * Connects to the broker via WebSocket (loopback) for push delivery, with a
 * polling fallback for resilience. SIGINT/SIGTERM transitions the peer to
 * 'dormant' via /disconnect (resume-able), instead of /unregister (DELETE).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { hostname } from "node:os";
import type {
  PublicPeer,
  RegisterResponse,
  PollMessagesResponse,
  GroupId,
  GroupStatsResponse,
  PeerId,
  InstanceToken,
  WhoamiResponse,
  ListGroupsResponse,
  SetIdResponse,
  RoadmapItem,
  RoadmapListResponse,
  RoadmapUpsertResponse,
  RoadmapArchiveResponse,
  RoadmapContextAppendResponse,
  RoadmapUpsertAckField,
} from "./shared/types.ts";
import {
  generateSummary,
  heuristicSummary,
  getGitBranch,
  getRecentFiles,
  computeProjectKey,
} from "./shared/summarize.ts";
import {
  loadConfig,
  brokerUrl,
  isLoopbackBrokerUrl,
  resolveProvider,
  resolveGroup,
  computeGroupId,
  computeGroupSecretHash,
} from "./shared/config.ts";
import {
  isDeckSender,
  isOperatorSender,
  renderInbound,
} from "./shared/inbound-framing.ts";
import { writePeerIdCache, writeDeskSessionId } from "./shared/peer-cache.ts";
import { createLogger, coreLogDir } from "./shared/logger.ts";
import {
  DECK_PEER_ID,
  DECK_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
  OPERATOR_INSTANCE_TOKEN,
  ROADMAP_UPSERT_ACK_FIELDS,
  ROADMAP_ADD_ACK_FIELDS,
  ROADMAP_UPDATE_ACK_FIELDS,
} from "./shared/types.ts";
import type { GraphDraftAddResponse } from "./shared/types.ts";
import type {
  ApprovalAddResponse,
  ApprovalWaitResponse,
} from "./shared/types.ts";
import {
  APPROVAL_QUESTION_MAX,
  APPROVAL_TITLE_MAX,
  buildAuthProof,
  loadSessionApprovalCredential,
} from "./shared/approval-client.ts";
import {
  buildDraftPrepareArgs,
  composeDraftUserMessage,
  parseDraftOutput,
  validateDraftPayload,
  GRAPH_DRAFT_SYSTEM_PROMPT,
  GRAPH_DRAFT_TIMEOUT_MS,
} from "./shared/graph-draft.ts";
import { buildRoadmapAppendHeader } from "./shared/roadmap-append.ts";
import { composeOutboundMessage } from "./shared/message-framing.ts";
import { resolveProjectKey } from "./shared/project-key.ts";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
// Cross-boundary import (server.ts lives at repo root, workflow.ts under
// desktop/): verified legal card 7defe381 LOT 1 -- `bunx tsc --noEmit -p
// tsconfig.json` produces the identical error count (338) with and without
// this import, because root tsconfig.json's `exclude: ["desktop"]` only
// drops desktop from the default glob, not from files reached by an explicit
// import (see the comment on that exclude). Single source of truth for
// "dispatch queue order" per CLAUDE.md: do not re-derive this sort locally.
import { queuedItems, wavesOf } from "./desktop/src/shared/workflow.ts";

const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

// --- Deck announcements (v0.3.4) ---
// Card e3f8065d: the two note constants and the five framing functions used to
// be DEFINED here. They now live in shared/inbound-framing.ts so that the third
// receive path (check_messages, below) consumes the SAME renderInbound as the WS
// push and the fallback poll, instead of re-implementing the branching inline.
// The module's header carries the full reasoning, including why the framing
// stays at reception rather than moving to emission.

// --- Configuration ---

const config = await loadConfig();
const BROKER_URL = brokerUrl(config);
const BROKER_TOKEN = config.broker_token ?? null;
const HEARTBEAT_INTERVAL_MS = 15_000;
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30_000;
// Fallback poll interval used when the WebSocket connection is down.
// Does NOT mark messages as delivered -- only check_messages does that.
const POLL_FALLBACK_INTERVAL_MS = parseInt(process.env.CLAUDE_PEERS_POLL_FALLBACK_SEC ?? "5", 10) * 1000;
const BROKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");

// --- Broker HTTP communication ---

function brokerHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (BROKER_TOKEN) h["Authorization"] = `Bearer ${BROKER_TOKEN}`;
  return h;
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: brokerHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function brokerGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, { headers: brokerHeaders() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  // HTTP-remote mode: the configured broker lives on another host, so a local
  // spawn would bind 127.0.0.1 and never satisfy isBrokerAlive() on the remote
  // URL. proc.unref() would then leak that local broker as a zombie after the
  // outer throw (observed as Bug F, 2026-05-15). Fail fast instead.
  if (!isLoopbackBrokerUrl(BROKER_URL)) {
    throw new Error(
      `Broker at ${BROKER_URL} is unreachable. Remote brokers (HTTP mode) must be started manually; refusing to spawn a local broker that would not serve this URL.`
    );
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

// Rolling file log (PLAN-observabilite-erreurs O1/O2). stdout carries the MCP
// stdio protocol, so the console mirror is disabled and both helpers keep the
// historical stderr line themselves.
const fileLog = createLogger({ dir: coreLogDir(), name: "server", mirrorToConsole: false });

function log(msg: string) {
  console.error(`[claude-peers] ${msg}`);
  fileLog.info(msg);
}

function logError(msg: string, e?: unknown) {
  console.error(`[claude-peers] ${msg}`);
  fileLog.error(msg, e);
}

// Last-resort safety nets: Bun exits on unhandled rejections; leave a trace
// first. Async cleanup (POST /disconnect) is not reliable here -- the broker's
// stale sweeps will mark the peer dormant.
process.on("uncaughtException", (e) => {
  logError("uncaught exception, exiting", e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  logError("unhandled rejection, exiting", e);
  process.exit(1);
});

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

// --- State (v0.3 dual identity) ---

let myInstanceToken: InstanceToken | null = null;
let myPeerId: PeerId | null = null;
let myGroupId: GroupId = "default";
let myGroupsMap: Record<string, GroupId> = { default: "default" };
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myProjectKey: string | null = null;
let myHost: string = hostname();
let myClientPid: number = process.pid;
let myRegisteredAt: string = "";
let wsConnected: boolean = false;
let wsSocket: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectDelay: number = WS_RECONNECT_INITIAL_MS;
// In-session deduplication: message IDs already dispatched via mcp.notification().
// Prevents the fallback poll from re-notifying messages that were already pushed
// via WS. Cleared on session restart (process exit), so resumed sessions still
// see unacknowledged messages. Only check_messages marks delivered in the DB.
const notifiedMessageIds = new Set<number>();
// Message ids whose pollFallback notification already logged a failure (dedup
// so a broken transport does not flood the log at every 5s poll).
const notifyFailedIds = new Set<number>();

function groupNameForId(id: GroupId): string {
  for (const [name, gid] of Object.entries(myGroupsMap)) {
    if (gid === id) return name;
  }
  return id === "default" ? "default" : "<unknown>";
}

// --- WebSocket transport ---

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  const delay = Math.min(wsReconnectDelay, WS_RECONNECT_MAX_MS);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    connectWs();
  }, delay);
}

function clearWsReconnect() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsReconnectDelay = WS_RECONNECT_INITIAL_MS;
}

function connectWs() {
  if (!myInstanceToken) return;
  // Close any existing socket cleanly before opening a new one.
  if (wsSocket && wsSocket.readyState !== WebSocket.CLOSED) {
    try { wsSocket.close(); } catch { /* ignore */ }
  }
  const wsUrl = BROKER_URL.replace(/^http/, "ws") + "/ws";
  // Bun's WebSocket constructor accepts an options object with custom headers.
  // Required when the broker enforces a Bearer token: the HTTP /ws upgrade
  // request itself must carry the Authorization header, otherwise it is
  // rejected with 401 before the auth frame is ever exchanged.
  const wsInit = BROKER_TOKEN
    ? ({ headers: { Authorization: `Bearer ${BROKER_TOKEN}` } } as unknown as string[])
    : undefined;
  const ws = new WebSocket(wsUrl, wsInit);
  wsSocket = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", instance_token: myInstanceToken }));
    wsConnected = true;
    clearWsReconnect();
    log("WebSocket connected");
  });

  ws.addEventListener("message", async (ev) => {
    let frame: { type: string; [k: string]: unknown };
    try {
      frame = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch {
      return;
    }
    if (frame.type === "message") {
      const f = frame as {
        type: "message";
        id: number;
        from_peer_id: string;
        from_summary: string;
        from_host: string;
        from_cwd: string;
        text: string;
        sent_at: string;
      };
      const fromDeck = isDeckSender(f.from_peer_id);
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: renderInbound(f.from_peer_id, f.text),
            meta: {
              from_peer_id: fromDeck ? DECK_PEER_ID : f.from_peer_id,
              from_summary: f.from_summary,
              from_cwd: f.from_cwd,
              from_host: f.from_host,
              sent_at: f.sent_at,
            },
          },
        });
        notifiedMessageIds.add(f.id);
        log(`Pushed message from ${fromDeck ? DECK_PEER_ID : f.from_peer_id}: ${f.text.slice(0, 80)}`);
      } catch (e) {
        log(`Notification dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  ws.addEventListener("close", () => {
    wsConnected = false;
    wsSocket = null;
    log("WebSocket closed; will retry");
    scheduleWsReconnect();
  });

  ws.addEventListener("error", () => {
    // 'close' will fire too -- log here just for visibility
    wsConnected = false;
  });
}

// --- Fallback poll (WS down path) ---

// Peeks at undelivered messages WITHOUT marking them delivered, then pushes
// mcp.notification() for each. Runs only when the WebSocket is disconnected,
// so it does not duplicate the real-time WS push. Messages stay delivered=0
// until Claude explicitly calls check_messages.
async function pollFallback() {
  if (wsConnected || !myInstanceToken) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/peek-messages", {
      instance_token: myInstanceToken,
    });
    const fresh = result.messages.filter((m) => !notifiedMessageIds.has(m.id));
    if (fresh.length === 0) return;
    // B1/NF-A: the broker already resolved the sender (from_peer_id + meta) and
    // never exposes routing tokens, so no /list-peers round-trip is needed.
    for (const msg of fresh) {
      const fromDeck = isDeckSender(msg.from_peer_id);
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: renderInbound(msg.from_peer_id, msg.text),
            meta: {
              from_peer_id: fromDeck ? DECK_PEER_ID : (msg.from_peer_id || "<dormant peer>"),
              from_summary: msg.from_summary,
              from_cwd: msg.from_cwd,
              from_host: msg.from_host,
              sent_at: msg.sent_at,
            },
          },
        });
        notifiedMessageIds.add(msg.id);
        notifyFailedIds.delete(msg.id);
      } catch (e) {
        // The message stays delivered=0 and is retried on the next poll; log the
        // first failure per message so a broken transport leaves a trace without
        // flooding one line per 5s poll.
        if (!notifyFailedIds.has(msg.id)) {
          notifyFailedIds.add(msg.id);
          logError(`pollFallback: mcp.notification failed for message ${msg.id} (will retry)`, e);
        }
      }
    }
  } catch { /* non-fatal */ }
}

// --- MCP server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.9.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network: other Claude Code instances on this machine and on other PCs sharing the same broker can see you and message you, scoped to your current group.

When a <channel source="claude-peers"> message arrives, reply now with send_message to its from_peer_id, then resume your work. Peer traffic is background work: do not narrate it to the operator. Tell the operator only when a human decision is needed, you are blocked, or the outcome changes your plan or result, and then in one or two sentences.

Tools: list_peers, send_message (expects_reply=false for pure information), set_summary, check_messages (polling fallback), whoami, list_groups, switch_group, set_id, the roadmap_* family, ask_operator / ask_operator_wait (blocking question to the human, answer may come from their phone), graph_draft_prepare / graph_draft_send (ONLY when the operator explicitly asks to move a question into the Koryphaios graph view).

Special recipient 'operator': send_message with to_peer_id 'operator' reaches the HUMAN operator's desktop inbox. Use it for blocking questions or findings that need a human decision; the answer comes back as a Deck announcement or new instructions, not through this channel. It needs a group that pins a secret (a Koryphaios Deck always does); in the secret-less 'default' group the send is refused, ask on screen instead.

SHARED ROADMAP: a persistent backlog (features, bugs, debt, ideas) scoped to this repository and shared with every Claude instance working on it, now and later.
- Start of a task: roadmap_list with a filter, to see what is planned and in progress.
- Bug, debt or idea outside your task: roadmap_add, with the 'context' field filled (the briefing a fresh session cannot rediscover from the repo).
- Keep the status of items you work on current (roadmap_update: planned -> in_progress -> done). in_progress LOCKS the item under your peer_id: set it only when you really start, set it back to planned if you stop before finishing.
- Team leads: a kind='directive' card (roadmap_add) lets the Deck reset a peer's context between items; you never run it yourself.

When you start, call set_summary to say what you are working on.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances connected to the same broker, in your current group. Returns peer_id, host, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all peers in your group on the broker. "directory" = same working directory. "repo" = same git repository (matched cross-PC via the normalized git remote URL).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer_id. The message is pushed via WebSocket if the recipient is connected, otherwise queued for their next poll.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_peer_id: {
          type: "string" as const,
          description: "The peer_id of the target Claude Code instance (from list_peers). Must be in your current group.",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
        expects_reply: {
          type: "boolean" as const,
          description:
            "Optional. Set to false for a message that INFORMS rather than asks: the recipient is then explicitly told not to acknowledge it, which saves them a whole inference turn. Omit it (or pass true) when you genuinely need an answer. Use false for results, status updates and hand-offs; use the default for questions and requests.",
        },
      },
      required: ["to_peer_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. Visible to other peers in your group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually poll for new messages. Messages normally arrive automatically via WebSocket; use this if you suspect the push channel is down.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "whoami",
    description:
      "Return your current peer_id, host, cwd, group_name, summary, and WebSocket connectivity status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_groups",
    description:
      "List groups available in user config and how many active peers each has. Includes the current group.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "switch_group",
    description:
      "Move this session to another group by name. Disconnects the current peer (kept as dormant for resume) and re-registers in the target group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "The group name as defined in user config (or 'default').",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "set_id",
    description:
      "Rename your peer_id within the current group. Refused with 409 if the name is already taken by another peer (active or dormant) in your group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        new_id: {
          type: "string" as const,
          description: "Your new peer_id. Must match ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$",
        },
      },
      required: ["new_id"],
    },
  },
  {
    name: "roadmap_list",
    // The singular filters (kind, status, priority, tag) left the SCHEMA in
    // spec_ec5cf671 but not the handler nor the broker: `kinds: ["bug"]` is
    // the same query, the broker takes the UNION of both forms
    // (mergeEnumFilter), and an agent still sending `kind` is served. Four
    // fewer properties read on every turn; no filter lost.
    description:
      "List the project's shared roadmap (persistent backlog scoped to this repository, shared across sessions). Always pass a filter (statuses, kinds, q ...) so you do not load the whole board. Within a filter: OR; between filters: AND. Archived items hidden unless include_archived.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kinds: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["feature", "bug", "debt", "idea", "chore", "directive"] },
        },
        statuses: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["idea", "planned", "in_progress", "done", "archived"] },
        },
        priorities: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["must", "should", "could", "wont"] },
        },
        efforts: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["low", "medium", "high"] },
        },
        values: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["low", "medium", "high"] },
        },
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Items carrying at least one of these tags.",
        },
        q: {
          type: "string" as const,
          description: "Free-text search over title, description and tags (order, case and accents ignored).",
        },
        q_deep: {
          type: "boolean" as const,
          description: "Widen `q` to rationale and context.",
        },
        include_archived: { type: "boolean" as const, description: "Default false." },
        order: {
          type: "string" as const,
          enum: ["queue"],
          description: "queue: real dispatch order (queue ascending, waves grouped) instead of MoSCoW groups.",
        },
      },
    },
  },
  {
    name: "roadmap_get",
    description:
      "Show the full detail of one roadmap item (description, rationale, tags, dependencies, authorship). Accepts a full id or a unique prefix (e.g. the 8-char id shown by roadmap_list).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
      },
      required: ["id"],
    },
  },
  // DESCRIPTION BUDGET (spec_ec5cf671). Every tool description below is read by
  // the model on EVERY turn of EVERY session, so a sentence here costs its
  // length times the turn count, while an error message costs once and only
  // when it fires. Keep in a description what changes the CALL (when to use
  // it, a parameter required by another, a lock, an irreversible effect, a
  // 409/403). Put the WHY in a comment like this one, and the remedy in the
  // refusal text. tests/server-mcp-surface-budget.test.ts caps the total.
  //
  // Directive cards (kind='directive'): the Deck itself types the command
  // (clear | compact | magic_compact) into the terminals of target_peer_ids
  // when the card reaches the head of the operator's dispatch queue; agents
  // never run it. A 'clear' between two independent items resets a peer's
  // context for free; the briefing for the NEXT item goes in that item's
  // `context`, not in the directive. 'clear' keeps system prompt, CLAUDE.md
  // and MCP; 'compact' costs one inference on the target's model;
  // 'magic_compact' is the deterministic plugin and falls back to compact.
  {
    name: "roadmap_add",
    description:
      "Add an item to the project's shared roadmap: a feature, bug, tech debt or idea you want to survive this session. Only title is required (defaults: kind=feature, priority=could, value/effort=medium, status=idea). Always fill `context`. kind='directive' is a control card the Deck executes on target_peer_ids (team leads only).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short imperative title." },
        kind: {
          type: "string" as const,
          enum: ["feature", "bug", "debt", "idea", "chore", "directive"],
          description: "Default feature.",
        },
        directive: {
          type: "string" as const,
          enum: ["clear", "compact", "magic_compact"],
          description:
            "REQUIRED when kind='directive': clear (free context reset), compact (one inference), magic_compact (plugin, falls back to compact).",
        },
        target_peer_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "kind='directive' only: peer_ids (from list_peers) that receive the command. Max 16 per card.",
        },
        description: { type: "string" as const, description: "Free markdown details." },
        rationale: { type: "string" as const, description: "Why it matters." },
        context: {
          type: "string" as const,
          description:
            "Briefing for the agent that picks this up in a FUTURE session with none of your context: objective, scope boundaries, relevant files/tests, acceptance criteria, decisions made. Write what a fresh session cannot rediscover from the repo.",
        },
        priority: {
          type: "string" as const,
          enum: ["must", "should", "could", "wont"],
          description: "MoSCoW, default could.",
        },
        value: { type: "string" as const, enum: ["low", "medium", "high"], description: "Default medium." },
        effort: { type: "string" as const, enum: ["low", "medium", "high"], description: "Default medium." },
        status: {
          type: "string" as const,
          enum: ["idea", "planned", "in_progress", "done"],
          description: "Default idea.",
        },
        tags: { type: "array" as const, items: { type: "string" as const } },
        depends_on: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Ids of items this one depends on.",
        },
      },
      required: ["title"],
    },
  },
  // [INACTIVE] is an operator flag with no agent-side field on purpose: it
  // takes a card out of every agent's reach until the operator lifts it. The
  // 403 fires on the CLAIM (in_progress or locked=true) whatever else the write
  // changes, so a retry with extra fields does not help.
  {
    name: "roadmap_update",
    description:
      "Partially update a roadmap item (only the fields you pass change): move status (planned -> in_progress -> done), reprioritize, retag, rewrite. id or unique prefix. status=archived archives, any other status restores. in_progress LOCKS the item under your peer_id, leaving it releases the lock; a status write on an item locked by another peer is refused (409): pick another item. Claiming a card marked [INACTIVE] is refused (403).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
        title: { type: "string" as const },
        kind: { type: "string" as const, enum: ["feature", "bug", "debt", "idea", "chore", "directive"] },
        directive: {
          type: "string" as const,
          enum: ["clear", "compact", "magic_compact"],
          description: "kind='directive' only.",
        },
        target_peer_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "kind='directive' only.",
        },
        description: { type: "string" as const },
        rationale: { type: "string" as const },
        context: {
          type: "string" as const,
          description: "Briefing for a future agent (see roadmap_add). Replaces the whole field.",
        },
        priority: { type: "string" as const, enum: ["must", "should", "could", "wont"] },
        value: { type: "string" as const, enum: ["low", "medium", "high"] },
        effort: { type: "string" as const, enum: ["low", "medium", "high"] },
        status: {
          type: "string" as const,
          enum: ["idea", "planned", "in_progress", "done", "archived"],
        },
        tags: { type: "array" as const, items: { type: "string" as const } },
        depends_on: { type: "array" as const, items: { type: "string" as const } },
        locked: {
          type: "boolean" as const,
          description: "Usually implicit. false releases your lock while staying in_progress, true re-claims.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "roadmap_archive",
    description:
      "Archive a roadmap item (reversible soft delete: it disappears from default lists but can be restored with roadmap_update status). Accepts a full id or a unique prefix.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
      },
      required: ["id"],
    },
  },
  // Four design facts the description used to spell out, kept here because
  // they explain the shape without changing the call: (1) the call is NOT
  // idempotent -- a retry after a lost response lands the block twice, and
  // duplicates are accepted on purpose (compact later rather than block the
  // retry); (2) the timestamped attribution header around every append is
  // what makes such a duplicate visible, so it always ships; (3) the Deck's
  // context textarea and the wand replace the WHOLE field on the operator's
  // next Save, so appended blocks are not durable structure; (4) the call does
  // not refresh updated_at, because updated_at drives the stale-lock TTL and a
  // third party's append must not extend another agent's lock. A too-large
  // append is refused with the remedies named in the refusal text.
  {
    name: "roadmap_append_context",
    description:
      "Append a note to a roadmap item's context without replacing it (roadmap_update replaces). Use it to leave a note on ANOTHER agent's card: the work-lock does not block it. Not idempotent (a retry may land twice, accepted). The operator's next Save may overwrite appended text: durable facts go in description/rationale. Does not refresh updated_at.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
        text: { type: "string" as const, description: "The note. Capped per call; the refusal names the limit." },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "graph_draft_prepare",
    description:
      "OPERATOR-INVITED ONLY: call it when the human operator explicitly asks to move a blocking question into the Koryphaios GRAPH view ('open a graph on this', 'passe en mode graphe'), never on your own initiative. Returns a prompt draft (question + relevant context and file references) for you to review, then submit with graph_draft_send. Nothing is sent at this stage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string" as const,
          description: "The blocking question, as raw as you like.",
        },
        hints: {
          type: "string" as const,
          description: "Optional: files, symbols or areas you already identified as relevant.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "graph_draft_send",
    description:
      "Send a reviewed graph draft to the operator's Deck. The draft is persisted broker-side (it survives Deck restarts) and appears in the operator inbox; when the operator opens it, it becomes a PRE-FILLED, UNSUBMITTED prompt node in a fresh graph conversation — the operator picks the target models and launches the inference. Pass the title and prompt from graph_draft_prepare, edited as you see fit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short title (becomes the graph name)." },
        prompt: {
          type: "string" as const,
          description: "The full prompt draft (markdown: question + curated context + references).",
        },
      },
      required: ["title", "prompt"],
    },
  },
  {
    name: "ask_operator",
    description:
      "Ask the HUMAN operator a blocking question and WAIT for the answer (it reaches them on their phone or the Deck, so use it instead of an on-screen question when they may be away). Returns the answer as free text, or a ticket: then call ask_operator_wait rather than assuming an answer. Available only when remote approvals are enabled for this project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string" as const,
          description: "Short subject line, shown as the notification title.",
        },
        question: {
          type: "string" as const,
          description:
            "The question, self-contained: the operator reads it on a phone with no repo access.",
        },
        options: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Optional suggested answers, offered as one-tap buttons.",
        },
      },
      required: ["title", "question"],
    },
  },
  {
    name: "ask_operator_wait",
    description:
      "Keep waiting for the answer to a previous ask_operator call. Pass the ticket it returned. Returns the operator's answer, or another ticket if they still have not replied.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ticket: { type: "string" as const, description: "The ticket returned by ask_operator." },
      },
      required: ["ticket"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

function formatElapsed(iso: string | null): string {
  if (!iso) return "never";
  const elapsed = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(elapsed / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatPeer(p: PublicPeer): string {
  const statusLabel = { active: "🟢 active", sleep: "🟡 sleep", closed: "🔴 closed" }[p.activity_status];
  // B1: the client PID is no longer exposed over the wire; show host only.
  const idLine = p.host ? `peer_id: ${p.peer_id}  (${p.host})` : `peer_id: ${p.peer_id}`;
  const parts = [`${statusLabel}  ${idLine}`, `CWD: ${p.cwd}`];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.project_key) parts.push(`Project: ${p.project_key}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last exchange: ${formatElapsed(p.last_activity_at)}`);
  return parts.join("\n  ");
}

// --- Roadmap helpers (v0.4, PLAN C3-M2) ---

/**
 * The roadmap scope for this session: the normalized git remote when there is
 * one (cross-PC repo matching), else a stable local fallback derived from the
 * git root / cwd so repos without a remote still get a per-project roadmap.
 */
function roadmapProjectKey(): string {
  return resolveProjectKey(myProjectKey, myGitRoot, myCwd);
}

/** Author stamp for roadmap writes: the resolved peer_id, else a host fallback. */
function roadmapAuthor(): string {
  return myPeerId ?? `${myHost || "unknown"}-unregistered`;
}

/**
 * Proof that accompanies `by` (roadmap card 39c40571, layer 1). The broker
 * REQUIRES it as soon as `by` names a registered peer, which is exactly the
 * case here once registration succeeded -- without it our own writes would be
 * refused as impersonation of ourselves. Omitted before registration, when the
 * author is the host fallback and belongs to no peer row.
 */
function roadmapProof(): Record<string, string> {
  return myInstanceToken ? { instance_token: myInstanceToken } : {};
}

/**
 * Resolve a full id or a UNIQUE id prefix (roadmap_list shows 8-char prefixes)
 * against the project's items, archived included. Throws a descriptive error
 * on no match / ambiguous prefix.
 */
async function resolveRoadmapId(idOrPrefix: string): Promise<string> {
  const needle = idOrPrefix.trim();
  if (!needle) throw new Error("empty id");
  const { items } = await brokerFetch<RoadmapListResponse>("/roadmap/list", {
    project_key: roadmapProjectKey(),
    include_archived: true,
  });
  const exact = items.find((i) => i.id === needle);
  if (exact) return exact.id;
  const matches = items.filter((i) => i.id.startsWith(needle));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new Error(`no roadmap item matches '${needle}'`);
  throw new Error(
    `ambiguous id prefix '${needle}' (${matches.length} matches) -- use more characters`
  );
}

function formatRoadmapItemLine(i: RoadmapItem): string {
  const tags = i.tags.length ? `  #${i.tags.join(" #")}` : "";
  const lock = i.locked ? ` 🔒${i.locked_by ?? ""}` : "";
  // Card c33a5968, major 2 (team-lead review, 2026-08-12): the population a
  // parked card is meant to keep OUT (any agent listing cards to pick one
  // up) previously had no way to see the flag before hitting a 403 that
  // tells it to do the one thing it is structurally forbidden from doing.
  const inactive = i.inactive ? " [INACTIVE -- do not claim]" : "";
  // Card 7defe381 LOT 1: a marker present ONLY when the card is enqueued, so
  // the vast majority of unenqueued cards pay zero extra chars per turn.
  const queueRank = i.queue !== null ? ` queue:${i.queue}` : "";
  return `[${i.id.slice(0, 8)}] ${i.kind} · ${i.priority} · value:${i.value} effort:${i.effort} · ${i.status}${queueRank}${lock}${inactive} — ${i.title}${tags}`;
}

/**
 * Card 7defe381 LOT 1: the roadmap in its REAL dispatch order, for
 * `roadmap_list({ order: "queue" })`. Delegates the ordering/grouping to
 * `queuedItems`/`wavesOf` (desktop/src/shared/workflow.ts) rather than
 * re-deriving a sort here -- that module is already the single source of
 * truth the Deck's own workflow lane draws from (see the import comment
 * above), so this view can never silently diverge from what the Deck shows.
 * `queuedItems` excludes done/archived rows even when they still carry a
 * stale `queue` value, so a finished card never resurfaces as pending.
 */
function formatRoadmapQueueOrder(items: RoadmapItem[]): string {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const ordered = queuedItems(items);
  const waves = wavesOf(ordered);
  const waveBlocks = waves.map((waveIds, idx) => {
    const rows = waveIds.map((id) => formatRoadmapItemLine(byId.get(id)!));
    return `WAVE ${idx + 1} (${rows.length} card${rows.length > 1 ? "s" : ""}, dispatched together):\n${rows.join("\n")}`;
  });
  const queuedIds = new Set(ordered.map((i) => i.id));
  const rest = items.filter((i) => !queuedIds.has(i.id));

  const parts: string[] = [];
  parts.push(
    waveBlocks.length
      ? `DISPATCH QUEUE (${ordered.length} card(s) in ${waves.length} wave(s)):\n\n${waveBlocks.join("\n\n")}`
      : "DISPATCH QUEUE: empty."
  );
  if (rest.length) {
    parts.push(`NOT QUEUED (${rest.length}):\n${rest.map(formatRoadmapItemLine).join("\n")}`);
  }
  return parts.join("\n\n");
}

function formatRoadmapItemDetail(i: RoadmapItem): string {
  const lines = [
    `${formatRoadmapItemLine(i)}`,
    `id: ${i.id}`,
    i.description ? `description: ${i.description}` : "",
    i.rationale ? `rationale: ${i.rationale}` : "",
    i.context ? `context (agent briefing): ${i.context}` : "",
    i.kind === "directive"
      ? `directive: /${i.directive} -> ${i.target_peer_ids.length ? i.target_peer_ids.join(", ") : "(no targets yet)"} (executed by the Deck when dispatched)`
      : "",
    i.depends_on.length ? `depends_on: ${i.depends_on.map((d) => d.slice(0, 8)).join(", ")}` : "",
    i.locked ? `locked: by ${i.locked_by} since ${i.locked_at} (actively being worked on)` : "",
    i.inactive ? `inactive: this card is inactive -- do not claim it or move it to in_progress; only an operator-signed write can clear this` : "",
    `created: ${i.created_at} by ${i.created_by}`,
    `updated: ${i.updated_at} by ${i.updated_by}`,
    i.deleted_at ? `archived: ${i.deleted_at}` : "",
  ].filter(Boolean);
  return lines.join("\n  ");
}

/**
 * Compact ack for roadmap_add/roadmap_update. Reports what the caller
 * REQUESTED (from `args`, to decide which fields to mention) crossed against
 * what actually LANDED (from the broker's returned `item`, via
 * ROADMAP_UPSERT_ACK_FIELDS -- shared/types.ts). Never trust `args` for a
 * value: broker-side normalization (title trim, cleanList/cleanPeerIds
 * dropping entries, the lock guard forcing `locked=false` outside
 * in_progress, target_peer_ids reset to [] outside kind='directive') means
 * the caller's raw argument is not the truth of what got persisted.
 *
 * `domain` is the PER-TOOL field list (ROADMAP_ADD_ACK_FIELDS /
 * ROADMAP_UPDATE_ACK_FIELDS) -- never a union: roadmap_add does not forward
 * `locked` to the broker at all, so it must never appear in that path's ack
 * even if the caller happened to pass it as an extra JSON property.
 */
function formatRoadmapUpsertAck(opts: {
  label: "created" | "updated";
  item: RoadmapItem;
  args: Record<string, unknown>;
  domain: readonly RoadmapUpsertAckField[];
}): string {
  const { label, item, args, domain } = opts;
  const passed: string[] = [];
  const untouched: string[] = [];
  for (const field of domain) {
    if (args[field] === undefined) {
      untouched.push(field);
      continue;
    }
    const spec = ROADMAP_UPSERT_ACK_FIELDS[field];
    const landed = spec.landed(item);
    if (spec.category === "long") {
      const requestedArg = args[field];
      const requestedLen = typeof requestedArg === "string" ? requestedArg.length : String(requestedArg).length;
      const landedLen = typeof landed === "string" ? landed.length : String(landed).length;
      passed.push(`${field}: requested ${requestedLen} chars, landed ${landedLen} chars`);
    } else if (spec.category === "list") {
      const landedCount = Array.isArray(landed) ? landed.length : 0;
      const requestedArg = args[field];
      const requestedCount = Array.isArray(requestedArg) ? requestedArg.length : 0;
      const suffix = requestedCount !== landedCount ? ` (requested ${requestedCount})` : "";
      passed.push(`${field} -> ${landedCount} item(s)${suffix}`);
    } else {
      const landedStr = String(landed);
      const requestedStr = String(args[field]);
      const suffix = requestedStr !== landedStr ? ` (requested ${requestedStr})` : "";
      passed.push(`${field} -> ${landedStr}${suffix}`);
    }
  }
  const passedLabel = label === "created" ? "set" : "changed";
  const untouchedLabel = label === "created" ? "defaults" : "unchanged";
  const lines = [`Roadmap item ${label}: ${item.id.slice(0, 8)}`];
  if (passed.length) lines.push(`  ${passedLabel}: ${passed.join(", ")}`);
  if (untouched.length) lines.push(`  ${untouchedLabel}: ${untouched.join(", ")}`);
  return lines.join("\n");
}

/**
 * Compact ack for roadmap_append_context. Never the appended content itself
 * (card 4dcd4f04, commit fb50266 -- do not regress it), but a DIFFERENT
 * wording than formatRoadmapUpsertAck's "requested N chars, landed M chars"
 * (review delta, card 562fd9b5): that phrase describes TWO STATES of the
 * SAME field on an upsert (before/after a replace). Append is not a
 * replace -- `requested` would be only the incoming fragment while `landed`
 * is the ENTIRE resulting context, so reusing the upsert wording here reads
 * as a massive, false deformation of what was sent ("requested 12 chars,
 * landed 3400 chars"). Says what actually happened instead: how much was
 * ADDED (header included, since that is what really left the wire), and
 * what the field's new total size is.
 *
 * Reuses ROADMAP_UPSERT_ACK_FIELDS's "context" landed-extractor for the
 * total (same discipline as formatRoadmapUpsertAck: never re-derive how to
 * read a field off an item). The appended length is computed the same way
 * the broker computed it -- buildRoadmapAppendHeader with the SAME author
 * this call sent as `by` -- rather than guessed: an ISO-8601 timestamp is
 * always 24 characters regardless of instant, so the header's length is
 * deterministic and does not need to match the broker's exact timestamp,
 * only its shape and author.
 */
function formatRoadmapAppendAck(requestedText: string, author: string, item: RoadmapItem): string {
  const landed = ROADMAP_UPSERT_ACK_FIELDS.context.landed(item);
  const landedLen = typeof landed === "string" ? landed.length : String(landed).length;
  const headerLen = buildRoadmapAppendHeader(new Date().toISOString(), author).length;
  const appendedLen = headerLen + requestedText.length;
  return [
    `Roadmap item context appended: ${item.id.slice(0, 8)}`,
    `  appended ${appendedLen} chars (header included), context now ${landedLen} chars`,
  ].join("\n");
}

const roadmapToolError = (e: unknown): { content: { type: "text"; text: string }[]; isError: true } => ({
  content: [
    {
      type: "text" as const,
      text: `Roadmap error: ${e instanceof Error ? e.message : String(e)}`,
    },
  ],
  isError: true,
});

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const peers = await brokerFetch<PublicPeer[]>("/list-peers", {
          scope,
          instance_token: myInstanceToken,
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found in group '${groupNameForId(myGroupId)}' (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map(formatPeer);
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) in group '${groupNameForId(myGroupId)}' (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "send_message": {
      // Accept both new (to_peer_id) and legacy (to_id) for robustness.
      // expects_reply is typed `unknown`, not `boolean`, deliberately: this is
      // an MCP tool argument, so the declared inputSchema describes what the
      // caller was ASKED for, never what arrived. composeOutboundMessage does
      // the strict-boolean check (see shared/message-framing.ts, which also
      // explains why the framing happens here at emission rather than on the
      // receiving side).
      const a = args as {
        to_peer_id?: string;
        to_id?: string;
        message: string;
        expects_reply?: unknown;
      };
      const target = a.to_peer_id ?? a.to_id;
      if (!target) {
        return {
          content: [{ type: "text" as const, text: "Missing 'to_peer_id'" }],
          isError: true,
        };
      }
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_token: myInstanceToken,
          to_peer_id: target,
          // `target` is passed so the operator inbox is never framed: this tool
          // accepts to_peer_id 'operator', which reaches a PERSON. See
          // composeOutboundMessage's own doc; the exclusion lives there, not
          // here, so a test can pin it.
          text: composeOutboundMessage(a.message, a.expects_reply, target),
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer '${target}'` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error sending message: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { instance_token: myInstanceToken, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
          instance_token: myInstanceToken,
        });
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No new messages." }] };
        }
        // B1/NF-A: from_peer_id is resolved by the broker; no /list-peers needed.
        // Card e3f8065d: this path used to re-implement the sender-class
        // branching of renderInbound, renderer by renderer. It now consumes the
        // shared enforcer, and keeps only what is genuinely its own -- the
        // "From <name> (<date>):" PREFIX. The split matters: the prefix
        // substitutes a DISPLAY name (a sentinel's public id, or the literal
        // "<dormant peer>" when the broker resolved none), whereas the framing
        // must key on the real sender identity. Passing the display fallback to
        // renderInbound would classify a dormant sender on a string that matches
        // no sentinel.
        const lines = result.messages.map((m) => {
          const label = isOperatorSender(m.from_peer_id)
            ? OPERATOR_PEER_ID
            : isDeckSender(m.from_peer_id)
              ? DECK_PEER_ID
              : m.from_peer_id || "<dormant peer>";
          return `From ${label} (${m.sent_at}):\n${renderInbound(m.from_peer_id, m.text)}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "whoami": {
      if (!myInstanceToken || !myPeerId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      // Pull current summary fresh from the broker via list_peers (own row not returned),
      // so fall back to a local cached summary or the latest set value. Simpler:
      // we rely on the latest applied set_summary or initial heuristic — reflected
      // by re-querying our own row via a lightweight self-lookup.
      let currentSummary = "";
      try {
        const peers = await brokerFetch<PublicPeer[]>("/list-peers", {
          scope: "machine",
          instance_token: myInstanceToken,
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
        });
        // list_peers excludes self; for whoami we don't need others. Try a
        // best-effort: if the broker exposes the row through some other path we'd
        // use it; for now, summary is reported by /poll-messages context. Skip.
        void peers;
      } catch { /* non-fatal */ }
      const result: WhoamiResponse = {
        peer_id: myPeerId,
        host: myHost,
        client_pid: myClientPid,
        cwd: myCwd,
        git_root: myGitRoot,
        // Resolved, not the raw myProjectKey: /register and roadmap_list
        // already store/scope on roadmapProjectKey()'s value (card 6aa32af4),
        // so a no-remote repo whose peers-table row carries the local:<hash>
        // fallback must show that same value here, not null -- otherwise
        // whoami contradicts what list_peers reports for this exact session.
        // Pinned by tests/roadmap-register-body.test.ts's whoami round trip.
        // Today this field is pure DISPLAY; the day something consumes it as
        // an input (the Deck, a script, an agent feeding it into roadmap_list)
        // a regression here stops being visible the way it is today -- keep
        // it wired to roadmapProjectKey(), never a locally recomputed value.
        project_key: roadmapProjectKey(),
        group_name: groupNameForId(myGroupId),
        summary: currentSummary,
        registered_at: myRegisteredAt,
        ws_connected: wsConnected,
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    case "list_groups": {
      try {
        const stats = await brokerGet<GroupStatsResponse>("/group-stats");
        const counts = new Map(stats.groups.map((g) => [g.group_id, g.active_peers]));
        const available = Object.keys(myGroupsMap).map((name) => ({
          name,
          active_peers: counts.get(myGroupsMap[name]!) ?? 0,
        }));
        const result: ListGroupsResponse = {
          current: groupNameForId(myGroupId),
          available,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error listing groups: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "switch_group": {
      const { name: targetName } = args as { name: string };
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      let secret: string | null;
      if (targetName === "default") {
        secret = null;
      } else {
        const candidate = config.groups[targetName];
        if (!candidate) {
          return {
            content: [{ type: "text" as const, text: `Group '${targetName}' not in user config` }],
            isError: true,
          };
        }
        secret = candidate;
      }
      const newGroupId = computeGroupId(secret);
      const newSecretHash = computeGroupSecretHash(secret);
      try {
        await brokerFetch("/disconnect", { instance_token: myInstanceToken });
        // Cancel any pending WS reconnect before switching identity.
        clearWsReconnect();
        if (wsSocket && wsSocket.readyState !== WebSocket.CLOSED) {
          try { wsSocket.close(); } catch { /* ignore */ }
        }
        const reg = await brokerFetch<RegisterResponse>("/register", {
          pid: process.pid,
          cwd: myCwd,
          git_root: myGitRoot,
          tty: null,
          summary: "",
          host: myHost,
          client_pid: myClientPid,
          // Card 6aa32af4: same resolved value as the initial /register --
          // see resolveProjectKey in shared/project-key.ts.
          project_key: roadmapProjectKey(),
          group_id: newGroupId,
          group_secret_hash: newSecretHash,
        });
        myInstanceToken = reg.instance_token;
        myPeerId = reg.peer_id;
        myGroupId = newGroupId;
        myRegisteredAt = new Date().toISOString();
        await writePeerIdCache(myCwd, myPeerId);
        await writeDeskSessionId();
        connectWs();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, new_peer_id: myPeerId, group_name: targetName }),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error switching group: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "set_id": {
      const { new_id } = args as { new_id: string };
      if (!PEER_ID_REGEX.test(new_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid peer_id (must match ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$)",
            },
          ],
          isError: true,
        };
      }
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<SetIdResponse | { error: string }>("/set-id", {
          instance_token: myInstanceToken,
          new_peer_id: new_id,
        });
        if ("error" in result) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          };
        }
        myPeerId = result.peer_id;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error setting id: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "roadmap_list": {
      const a = args as {
        kind?: string;
        status?: string;
        priority?: string;
        tag?: string;
        include_archived?: boolean;
        kinds?: string[];
        statuses?: string[];
        priorities?: string[];
        efforts?: string[];
        values?: string[];
        tags?: string[];
        q?: string;
        q_deep?: boolean;
        order?: string;
      };
      try {
        const { items } = await brokerFetch<RoadmapListResponse>("/roadmap/list", {
          project_key: roadmapProjectKey(),
          kind: a.kind,
          status: a.status,
          priority: a.priority,
          tag: a.tag,
          include_archived: a.include_archived ?? false,
          kinds: a.kinds,
          statuses: a.statuses,
          priorities: a.priorities,
          efforts: a.efforts,
          values: a.values,
          tags: a.tags,
          q: a.q,
          q_deep: a.q_deep,
        });
        if (items.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "The roadmap is empty (for these filters). Use roadmap_add to record features, bugs, debt or ideas.",
              },
            ],
          };
        }
        // Card 7defe381 LOT 1: `order: "queue"` renders the real dispatch
        // order instead of the MoSCoW grouping below -- the default view is
        // untouched so every other agent's habitual reading of this tool
        // does not change shape.
        const body =
          a.order === "queue"
            ? formatRoadmapQueueOrder(items)
            : (() => {
                // Group by MoSCoW priority for a scannable overview.
                const moscow = ["must", "should", "could", "wont"] as const;
                return moscow
                  .map((p) => {
                    const rows = items.filter((i) => i.priority === p);
                    if (rows.length === 0) return "";
                    return `${p.toUpperCase()} (${rows.length}):\n${rows.map(formatRoadmapItemLine).join("\n")}`;
                  })
                  .filter(Boolean)
                  .join("\n\n");
              })();
        return {
          content: [
            {
              type: "text" as const,
              text: `${items.length} roadmap item(s):\n\n${body}\n\nUse roadmap_get <id> for details, roadmap_update to change status.`,
            },
          ],
        };
      } catch (e) {
        return roadmapToolError(e);
      }
    }

    case "roadmap_get": {
      const a = args as { id: string };
      try {
        const id = await resolveRoadmapId(a.id);
        const { items } = await brokerFetch<RoadmapListResponse>("/roadmap/list", {
          project_key: roadmapProjectKey(),
          include_archived: true,
        });
        const item = items.find((i) => i.id === id);
        if (!item) throw new Error(`item ${id} vanished`);
        return {
          content: [{ type: "text" as const, text: formatRoadmapItemDetail(item) }],
        };
      } catch (e) {
        return roadmapToolError(e);
      }
    }

    case "roadmap_add": {
      const a = args as Record<string, unknown> & { title: string };
      try {
        const { item } = await brokerFetch<RoadmapUpsertResponse>("/roadmap/upsert", {
          project_key: roadmapProjectKey(),
          by: roadmapAuthor(),
          ...roadmapProof(),
          title: a.title,
          kind: a.kind,
          description: a.description,
          rationale: a.rationale,
          context: a.context,
          priority: a.priority,
          value: a.value,
          effort: a.effort,
          status: a.status,
          tags: a.tags,
          depends_on: a.depends_on,
          directive: a.directive,
          target_peer_ids: a.target_peer_ids,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatRoadmapUpsertAck({
                label: "created",
                item,
                args: a,
                domain: ROADMAP_ADD_ACK_FIELDS,
              }),
            },
          ],
        };
      } catch (e) {
        return roadmapToolError(e);
      }
    }

    case "roadmap_update": {
      const a = args as Record<string, unknown> & { id: string };
      try {
        const id = await resolveRoadmapId(a.id);
        const { item } = await brokerFetch<RoadmapUpsertResponse>("/roadmap/upsert", {
          id,
          by: roadmapAuthor(),
          ...roadmapProof(),
          title: a.title,
          kind: a.kind,
          description: a.description,
          rationale: a.rationale,
          context: a.context,
          priority: a.priority,
          value: a.value,
          effort: a.effort,
          status: a.status,
          tags: a.tags,
          depends_on: a.depends_on,
          directive: a.directive,
          target_peer_ids: a.target_peer_ids,
          locked: typeof a.locked === "boolean" ? a.locked : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatRoadmapUpsertAck({
                label: "updated",
                item,
                args: a,
                domain: ROADMAP_UPDATE_ACK_FIELDS,
              }),
            },
          ],
        };
      } catch (e) {
        return roadmapToolError(e);
      }
    }

    case "roadmap_archive": {
      const a = args as { id: string };
      try {
        const id = await resolveRoadmapId(a.id);
        const { item } = await brokerFetch<RoadmapArchiveResponse>("/roadmap/archive", {
          id,
          by: roadmapAuthor(),
          ...roadmapProof(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Roadmap item archived (restorable via roadmap_update status):\n${formatRoadmapItemLine(item)}`,
            },
          ],
        };
      } catch (e) {
        return roadmapToolError(e);
      }
    }

    case "roadmap_append_context": {
      const a = args as { id: string; text: string };
      try {
        const id = await resolveRoadmapId(a.id);
        const by = roadmapAuthor();
        const { item } = await brokerFetch<RoadmapContextAppendResponse>("/roadmap/append-context", {
          id,
          by,
          ...roadmapProof(),
          text: a.text,
        });
        return {
          content: [{ type: "text" as const, text: formatRoadmapAppendAck(a.text, by, item) }],
        };
      } catch (e) {
        return roadmapToolError(e);
      }
    }

    case "graph_draft_prepare": {
      const a = args as { question?: string; hints?: string };
      const question = (a.question ?? "").trim();
      if (!question) {
        return {
          content: [{ type: "text" as const, text: "question is required" }],
          isError: true,
        };
      }
      try {
        const output = await runDraftOneShot(composeDraftUserMessage(question, a.hints));
        const { title, prompt } = parseDraftOutput(output, question.slice(0, 80));
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Draft prepared — REVIEW IT (edit or re-run with better hints if off), then submit with graph_draft_send:\n\n` +
                `title: ${title}\n\n${prompt}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `graph_draft_prepare failed: ${msg}` }],
          isError: true,
        };
      }
    }

    case "ask_operator":
    case "ask_operator_wait": {
      const cred = loadSessionApprovalCredential();
      if (!cred) {
        return {
          content: [
            {
              type: "text" as const,
              // Card 469f3176: the credential is armed unconditionally at Deck
              // startup and inherited by every session spawned AFTER that (the
              // env var travels at spawn time only). This refusal therefore no
              // longer means "no remote channel configured" -- it means THIS
              // session predates the arming, so it never inherited
              // CLAUDE_PEERS_APPROVAL_FILE. Naming the real cause here, not a
              // stale one, since a wrong-but-plausible reason is worse than none.
              text: "This session started before remote approvals were armed, so it never inherited the credential. Restart the session to pick it up, or ask the operator directly, on screen.",
            },
          ],
          isError: true,
        };
      }

      /** Sign + POST an approval route with this session's restricted credential. */
      const signedPost = async <T>(path: string, payload: Record<string, unknown>): Promise<T> => {
        const body = { ...payload, public_key: cred.publicKey };
        const auth = buildAuthProof(cred.privateKey, body, {
          kind: "session",
          operator_id: cred.operatorId,
          token_id: cred.tokenId,
        });
        return brokerFetch<T>(path, { ...body, auth });
      };

      try {
        let approvalId: string;
        if (name === "ask_operator") {
          const title = String((args as { title?: unknown }).title ?? "").trim();
          const question = String((args as { question?: unknown }).question ?? "").trim();
          if (!title || !question) {
            return {
              content: [{ type: "text" as const, text: "title and question are required" }],
              isError: true,
            };
          }
          const rawOptions = (args as { options?: unknown }).options;
          const created = await signedPost<ApprovalAddResponse>("/approval/add", {
            kind: "question",
            title: title.slice(0, APPROVAL_TITLE_MAX),
            question: question.slice(0, APPROVAL_QUESTION_MAX),
            options: Array.isArray(rawOptions) ? rawOptions.slice(0, 10).map(String) : [],
            session_ref: cred.sessionRef,
            // Belt and braces: the tool returns the answer directly, but if the
            // agent stops polling its ticket the broker still hands it over as
            // a peer message rather than stranding it.
            reply_route: "channel",
            reply_peer_id: myPeerId ?? undefined,
            origin: {
              host: myHost,
              os_user_hash: cred.osUserHash,
              project_key: roadmapProjectKey(),
              from_peer: roadmapAuthor(),
              group_id: myGroupId,
            },
          });
          approvalId = created.approval.id;
        } else {
          approvalId = String((args as { ticket?: unknown }).ticket ?? "").trim();
          if (!approvalId) {
            return { content: [{ type: "text" as const, text: "ticket is required" }], isError: true };
          }
        }

        // Bounded leg: never rely on the MCP client's own tool timeout. When it
        // lapses we hand back a ticket, so waiting is resumable indefinitely
        // without any single call hanging.
        const res = await signedPost<ApprovalWaitResponse>("/approval/wait", {
          id: approvalId,
          timeout_sec: 90,
        });
        const answered = res.approval?.status === "answered" ? res.approval : null;
        if (answered) {
          const verdict =
            answered.answer_kind === "text"
              ? (answered.answer_text ?? "")
              : answered.answer_kind === "allow"
                ? "yes / approved"
                : "no / rejected";
          return {
            content: [
              {
                type: "text" as const,
                text: `The operator answered (via ${answered.answered_via}): ${verdict}`,
              },
            ],
          };
        }
        if (res.approval && res.approval.status !== "pending") {
          return {
            content: [
              {
                type: "text" as const,
                text: "That question is no longer awaiting an answer (it expired or was withdrawn). Ask the operator on screen.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `No answer yet. The operator has been notified. Call ask_operator_wait with ticket "${approvalId}" to keep waiting — do not assume an answer.`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: `${name} failed: ${msg}` }], isError: true };
      }
    }

    case "graph_draft_send": {
      const payload = validateDraftPayload(args as { title?: unknown; prompt?: unknown });
      if ("error" in payload) {
        return { content: [{ type: "text" as const, text: payload.error }], isError: true };
      }
      try {
        const { draft } = await brokerFetch<GraphDraftAddResponse>("/graph-draft/add", {
          project_key: roadmapProjectKey(),
          by: roadmapAuthor(),
          title: payload.title,
          prompt: payload.prompt,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Graph draft sent to the operator's Deck (id ${draft.id}). It stays pending — broker-persisted — until the operator opens it in the graph view, picks models and launches the inference. You can go back to your task.`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `graph_draft_send failed: ${msg}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

/**
 * Run the read-only pinned-haiku one-shot that compiles a graph draft
 * (system prompt = CODE CONSTANT, array-argv spawn: no shell quoting).
 */
async function runDraftOneShot(userMessage: string): Promise<string> {
  const dir = join(tmpdir(), "claude-peers-graph-draft");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `system-${process.pid}-${Date.now()}.md`);
  writeFileSync(file, GRAPH_DRAFT_SYSTEM_PROMPT, "utf-8");
  const proc = Bun.spawn({
    cmd: buildDraftPrepareArgs({ userMessage, systemPromptFile: file }),
    cwd: myCwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), GRAPH_DRAFT_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`haiku one-shot failed (exit ${code}): ${(err || out).slice(0, 400)}`);
    }
    const text = out.trim();
    if (!text) throw new Error("haiku one-shot returned nothing");
    return text;
  } finally {
    clearTimeout(timer);
    try {
      unlinkSync(file);
    } catch {
      // best-effort cleanup
    }
  }
}

// --- Startup ---

async function main() {
  log("Local context detection...");
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  myProjectKey = await computeProjectKey(myCwd);
  const host = hostname();
  const clientPid = process.pid;
  const tty = process.stdin.isTTY ? "tty" : null;
  const gitBranch = await getGitBranch(myCwd);
  const recentFiles = await getRecentFiles(myCwd);
  const { group_id: groupId, group_secret_hash: groupSecretHash, groups_map: groupsMap, name: groupName } = resolveGroup(myCwd, myGitRoot, config);
  log(`Local group resolution: ${groupName} (id: ${groupId.slice(0, 8)})`);

  myHost = host;
  myClientPid = clientPid;
  myGroupId = groupId;
  myGroupsMap = groupsMap;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Project key: ${myProjectKey ?? "(none)"}`);
  log(`Host: ${host}  client_pid: ${clientPid}`);
  log(`Group: ${groupNameForId(groupId)} (id: ${groupId.slice(0, 8)})`);

  await ensureBroker();

  const initialSummary = heuristicSummary({
    cwd: myCwd,
    git_root: myGitRoot,
    git_branch: gitBranch,
    recent_files: recentFiles,
  });
  log(`Heuristic summary: ${initialSummary}`);

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    host,
    client_pid: clientPid,
    claude_cli_pid: process.ppid,
    // Card 6aa32af4: same resolved value roadmap cards are scoped under
    // (never the raw, possibly-null myProjectKey) -- see resolveProjectKey
    // in shared/project-key.ts for why the two must never diverge.
    project_key: roadmapProjectKey(),
    group_id: groupId,
    group_secret_hash: groupSecretHash,
  });
  myInstanceToken = reg.instance_token;
  myPeerId = reg.peer_id;
  myRegisteredAt = new Date().toISOString();
  await writePeerIdCache(myCwd, myPeerId);
  // Deck back-channel: hand the real minted session id to the per-tile token file
  // so the Deck maps tile -> session id deterministically (no-op outside the Deck).
  await writeDeskSessionId();
  log(`Registered as peer '${myPeerId}' (instance ${myInstanceToken.slice(0, 8)})`);

  // Background summary upgrade.
  (async () => {
    try {
      const provider = resolveProvider(config);
      const summary = await generateSummary(
        { cwd: myCwd, git_root: myGitRoot, git_branch: gitBranch, recent_files: recentFiles },
        {
          provider,
          api_key: config.summary_api_key ?? process.env.ANTHROPIC_API_KEY ?? null,
          model: config.summary_model,
          base_url: config.summary_base_url,
        }
      );
      log(`Summary provider: ${provider} (model: ${config.summary_model})`);
      if (summary && summary !== initialSummary && myInstanceToken) {
        await brokerFetch("/set-summary", { instance_token: myInstanceToken, summary });
        log(`Summary upgraded: ${summary}`);
      }
    } catch (e) {
      log(`Background summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  const transport = new StdioServerTransport(process.stdin, process.stdout);
  await mcp.connect(transport);
  log("MCP connected");

  // Open WebSocket for push delivery.
  connectWs();

  const heartbeatTimer = setInterval(async () => {
    if (myInstanceToken) {
      try {
        await brokerFetch("/heartbeat", { instance_token: myInstanceToken });
      } catch { /* non-critical */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const fallbackPollTimer = setInterval(() => { pollFallback().catch(() => {}); }, POLL_FALLBACK_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(heartbeatTimer);
    clearInterval(fallbackPollTimer);
    clearWsReconnect();
    if (wsSocket && wsSocket.readyState !== WebSocket.CLOSED) {
      try { wsSocket.close(); } catch { /* ignore */ }
    }
    if (myInstanceToken) {
      try {
        await brokerFetch("/disconnect", { instance_token: myInstanceToken });
        log("Disconnected (peer kept as dormant for resume)");
      } catch { /* best effort */ }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let shuttingDown = false;
  const stdinShutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`stdin ${reason} -- Claude Code closed, shutting down`);
    try { await cleanup(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.stdin.on("end", () => { void stdinShutdown("end"); });
  process.stdin.on("close", () => { void stdinShutdown("close"); });
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
