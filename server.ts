#!/usr/bin/env bun
/**
 * SIGINT/SIGTERM transitions the peer to 'dormant' via /disconnect
 * (resume-able) rather than /unregister (DELETE).
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
  buildSummaryProviderConfig,
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
import type { DispatchRequest, DispatchRequestAddResponse } from "./shared/types.ts";
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
import {
  runWaitForMessage,
  buildWaiter,
  selectFreshWaitCandidates,
  WAIT_FOR_MESSAGE_HARD_CAP_SEC,
  tryResolveWaiters,
  removeWaiter,
  type MessageWaiter,
  type WaitCandidateMessage,
} from "./shared/wait-for-message.ts";
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

// signal is optional and defaults to undefined so every existing brokerFetch
// caller is unaffected; only wait_for_message's own opportunistic peek supplies
// it, bounding that one fetch by the tool's own cap.
// Not a global default: imposing a timeout here would change behaviour for
// every other caller of brokerFetch.
async function brokerFetch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: brokerHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
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

  // HTTP-remote mode fails fast instead of spawning a local broker: a local
  // spawn would bind 127.0.0.1 and never satisfy the remote URL, leaking the
  // spawned process as a zombie after the outer throw.
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
// Card a2f61172: the role echoed back by /register -- a launch property, the
// transport wins on every register call, dormant resume included. Only
// whoami reads this -- it is not otherwise consumed by this process.
let myRole: string | null = null;
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
// Card a21f1303 (H4 volet 3): pending wait_for_message calls. Fed by the two
// EXISTING message-delivery paths below (connectWs's WS handler, pollFallback)
// via tryResolveWaiters -- no third transport, no polling loop of its own.
// Never touched by anything that marks delivered: see shared/wait-for-message.ts
// header for why (zero-message-lost, no broker.ts changes in this card).
let pendingWaiters: MessageWaiter[] = [];

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
      // Card a21f1303: a pending wait_for_message call is resolved here
      // FIRST, before the ordinary mcp.notification() push -- this is the
      // "attend la frame WS deja poussee" path the design brief asks for,
      // not a new transport. Neither this nor tryResolveWaiters() itself
      // ever marks the message delivered (see shared/wait-for-message.ts),
      // so a waiter that does NOT match still leaves the message exactly as
      // untouched as it would be with zero waiters registered.
      const { remaining, resolved } = tryResolveWaiters(pendingWaiters, f as WaitCandidateMessage);
      pendingWaiters = remaining;
      if (resolved.length > 0) {
        for (const w of resolved) w.resolve(f as WaitCandidateMessage);
        notifiedMessageIds.add(f.id); // already handed to its waiter -- don't also notify it
        log(`Resolved ${resolved.length} wait_for_message call(s) from ${f.from_peer_id}`);
        return;
      }
      const fromDeck = isDeckSender(f.from_peer_id);
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: renderInbound(f.from_peer_id, f.text, myRole),
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
    // Card a21f1303: same shared predicate as wait_for_message's opportunistic
    // peek (selectFreshWaitCandidates) -- one discipline, not two.
    const fresh = selectFreshWaitCandidates(result.messages, notifiedMessageIds);
    if (fresh.length === 0) return;
    // B1/NF-A: the broker already resolved the sender (from_peer_id + meta) and
    // never exposes routing tokens, so no /list-peers round-trip is needed.
    for (const msg of fresh) {
      // Card a21f1303: same waiter-resolution step as connectWs's WS handler
      // above -- this IS "le repli sur poll periodique /peek-messages" the
      // design brief asks for, not a second implementation of the idea.
      // /peek-messages never marks delivered, so a non-matching waiter (or
      // zero waiters) leaves `msg` exactly as untouched as it is today.
      const { remaining, resolved } = tryResolveWaiters(pendingWaiters, msg as WaitCandidateMessage);
      pendingWaiters = remaining;
      if (resolved.length > 0) {
        for (const w of resolved) w.resolve(msg as WaitCandidateMessage);
        notifiedMessageIds.add(msg.id);
        continue;
      }
      const fromDeck = isDeckSender(msg.from_peer_id);
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: renderInbound(msg.from_peer_id, msg.text, myRole),
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

Tools: list_peers, send_message, set_summary, wait_for_message, check_messages, whoami, list_groups, switch_group, set_id, the roadmap_* family, ask_operator / ask_operator_wait, graph_draft_prepare / graph_draft_send.

Special recipient 'operator': send_message with to_peer_id 'operator' reaches the HUMAN operator's desktop inbox. Use it for blocking questions or findings that need a human decision; the answer comes back as a Deck announcement or new instructions, not through this channel. It needs a group that pins a secret (a Koryphaios Deck always does); in the secret-less 'default' group the send is refused, ask on screen instead.

SHARED ROADMAP: a persistent backlog (features, bugs, debt, ideas) scoped to this repository and shared with every Claude instance working on it, now and later.
- Start of a task: roadmap_list with a filter, to see what is planned and in progress.
- Bug, debt or idea outside your task: roadmap_add, with the 'context' field filled.
- Keep the status of items you work on current (roadmap_update: planned -> in_progress -> done). in_progress LOCKS the item under your peer_id: set it only when you really start, set it back to planned if you stop before finishing.
- Team leads: a kind='directive' card (roadmap_add) lets the Deck reset a peer's context between items; queue it, then roadmap_dispatch runs the head wave and reports back what it hit.

When you start, call set_summary to say what you are working on.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances connected to the same broker, in your current group. Returns peer_id, host, working directory, git repo, role, and summary.",
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
    name: "wait_for_message",
    description:
      `Blocks until a peer message arrives (prefer over polling check_messages), resolving with it (from from_peer_id if given, else anyone) or { timed_out: true } after up to ${WAIT_FOR_MESSAGE_HARD_CAP_SEC}s (longer requests clamp). Not marked read: it reappears in check_messages too -- don't call that right after a match or you'll act twice.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        timeout_sec: {
          type: "number" as const,
          description: `Seconds to wait, capped at ${WAIT_FOR_MESSAGE_HARD_CAP_SEC} (omit for the default).`,
        },
        from_peer_id: {
          type: "string" as const,
          description: "Only from this peer_id; omit for any sender.",
        },
      },
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
  // Directive cards run when reached at the head of the dispatch queue: the
  // Deck types the command into target_peer_ids' terminals, agents never invoke
  // it themselves.
  // 'clear' resets a peer's context for free and keeps system prompt, CLAUDE.md
  // and MCP; 'compact' costs one inference; 'magic_compact' is the
  // deterministic plugin, falling back to compact.
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
            "Briefing for a future session with none of this one's context: objective, scope boundaries, relevant files/tests, acceptance criteria, decisions made -- what the repo alone won't reveal.",
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
  // [INACTIVE] has no agent-side field: only the operator can lift it, and
  // claiming (in_progress or locked=true) 403s regardless of what else the
  // write changes -- a retry with extra fields does not help.
  // status:in_progress locks the item under the caller's own peer_id so two
  // peers cannot claim the same card.
  // The broker's force:true override exists but is not exposed by this tool.
  {
    name: "roadmap_update",
    description:
      "Partially update a roadmap item (only fields you pass change): reprioritize, retag, rewrite, or move status. status=archived archives, any other status restores. status:in_progress locks it; a status write on an item locked by another peer is refused (409). Claiming an [INACTIVE] card is refused (403).",
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
        // queue sets only this card's own rank; it never reorders or renumbers
        // the rest of the queue. Global reorder is /roadmap/reorder,
        // deliberately not exposed here.
        queue: { type: "number" as const, description: "Rank; null dequeues; ties share a wave." },
      },
      required: ["id"],
    },
  },
  {
    name: "roadmap_archive",
    description:
      "Archive a roadmap item (reversible soft delete: it disappears from default lists but can be restored with roadmap_update status).",
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
  // No arguments: the head wave is already selected by the queue, so a caller
  // cannot aim at a different card.
  // runDirectiveWave marks a card done before it executes, so status alone
  // proves nothing about execution -- the reply is the actual result.
  {
    name: "roadmap_dispatch",
    description:
      "Run the head wave of the roadmap queue in the operator's Deck, like its Dispatch button; no argument. Waits ~25 s and returns which cards were dispatched and which tiles were hit, refused or missed.",
    inputSchema: { type: "object" as const, properties: {} },
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
      "Send a reviewed graph draft to the operator's Deck. The draft is persisted broker-side (it survives Deck restarts) and appears in the operator inbox; when the operator opens it, it becomes a PRE-FILLED, UNSUBMITTED prompt node in a fresh graph conversation. Pass the title and prompt from graph_draft_prepare, edited as you see fit.",
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

// CLAUDE_PEERS_TOOLS: unset exposes every tool; set to a comma-separated list
// exposes exactly those names; set to the empty string exposes none. The three
// states are distinguished deliberately.
// Applies to the process Kory spawns per session tile; a sub-agent inherits the
// already-connected parent server, so this has no effect on sub-agents.
const TOOLS_ENV_VAR = "CLAUDE_PEERS_TOOLS";

/**
 * Pure allow-list resolver. `undefined` (env var absent) means "no
 * restriction" -- distinct from `[]` (env var present and empty, meaning
 * zero tools). Kept pure so a test can drive it without spawning a process
 * or touching env.
 */
function resolveToolAllowlist(envValue: string | undefined): string[] | null {
  if (envValue === undefined) return null;
  if (envValue === "") return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pure filter: `null` allowlist (var absent) passes every tool through
 * unchanged. The Set intersection means the allow-list can only SHRINK the
 * surface below TOOLS, never grow it -- a stale or misspelled name in the
 * env var is silently dropped, never surfaced as a phantom tool.
 */
function filterTools(tools: typeof TOOLS, allowlist: string[] | null): typeof TOOLS {
  if (allowlist === null) return tools;
  const allowed = new Set(allowlist);
  return tools.filter((t) => allowed.has(t.name));
}

const TOOLS_ALLOWLIST_RAW = process.env[TOOLS_ENV_VAR];
const TOOLS_ALLOWLIST = resolveToolAllowlist(TOOLS_ALLOWLIST_RAW);
const FILTERED_TOOLS = filterTools(TOOLS, TOOLS_ALLOWLIST);

// Resolution trace at startup: when a tool is missing from a caller's
// surface, this is what says whether CLAUDE_PEERS_TOOLS ate it and what the
// requested vs retained lists were -- without it, diagnosing a missing tool
// costs an hour of guessing (same rationale as deck-control-mcp.ts's own
// startup trace, Card ff091064).
log(
  `Tool allowlist resolved (source: ${
    TOOLS_ALLOWLIST_RAW === undefined ? "unset (no restriction)" : TOOLS_ENV_VAR
  }); requested=${JSON.stringify(TOOLS_ALLOWLIST)} retained=${JSON.stringify(
    FILTERED_TOOLS.map((t) => t.name)
  )}`
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: FILTERED_TOOLS,
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
  const idLine = p.host ? `peer_id: ${p.peer_id}  (${p.host})` : `peer_id: ${p.peer_id}`;
  const parts = [`${statusLabel}  ${idLine}`, `CWD: ${p.cwd}`];
  if (p.role) parts.push(`Role: ${p.role}`);
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.project_key) parts.push(`Project: ${p.project_key}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last exchange: ${formatElapsed(p.last_activity_at)}`);
  return parts.join("\n  ");
}

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
 * Card bf76d37f. Render what the wave ACTUALLY did. Never "ok": the caller
 * must be able to tell "dispatched to these tiles" from "nothing was queued"
 * from "still running", because a directive card is marked done before it is
 * executed and its status therefore acknowledges nothing.
 */
function renderDispatchOutcome(request: DispatchRequest): string {
  if (request.status !== "done" || !request.outcome) {
    return `Dispatch requested (id ${request.id}) — the Deck had not answered within the wait. The request is PARKED broker-side, not lost: the Deck runs it and announces the outcome on this channel. Do not assume it ran.`;
  }
  const { cards, note } = request.outcome;
  if (cards.length === 0) {
    return `Dispatch ran, and dispatched NOTHING${note ? `: ${note}` : "."} Nothing in the queue was eligible, so no tile was touched.`;
  }
  const lines = cards.map((c) => {
    const parts = [`  - [${c.id.slice(0, 8)}] ${c.kind}: ${c.title}`];
    parts.push(`    hit: ${c.matched.length > 0 ? c.matched.join(", ") : "(none)"}`);
    if (c.missing.length > 0) parts.push(`    NOT hit: ${c.missing.join(", ")}`);
    if (c.ambiguous.length > 0) {
      parts.push(`    refused as ambiguous (several live tiles share the id): ${c.ambiguous.join(", ")}`);
    }
    return parts.join("\n");
  });
  return `Dispatch ran. ${cards.length} card(s) dispatched:\n${lines.join("\n")}${note ? `\n${note}` : ""}`;
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
  // Shown in list output so an agent evaluating a card sees it is blocked
  // before attempting the claim that would 403.
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
 * Reports what the caller requested crossed against what the broker actually
 * landed (via ROADMAP_UPSERT_ACK_FIELDS); args are never trusted directly since
 * the broker silently normalizes or drops fields.
 * domain is per-tool, never a union: roadmap_add never forwards locked, so it
 * must never appear in that path's ack even if passed.
 * When the caller's own instance token matches item.locked_by_token, the ack
 * adds one trailer line reminding it how to release its own claim; no lookup or
 * trailer otherwise.
 */
function formatRoadmapUpsertAck(opts: {
  label: "created" | "updated";
  item: RoadmapItem;
  args: Record<string, unknown>;
  domain: readonly RoadmapUpsertAckField[];
  holderInstanceToken?: string;
}): string {
  const { label, item, args, domain, holderInstanceToken } = opts;
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
  // Card 4441e883: `item.locked_by_token` is null on any unproven/unclaimed
  // lock (see RoadmapItem.locked_by_token's doc comment) -- the `!== null`
  // guard is what keeps two undefined/absent tokens from reading as a match.
  if (
    holderInstanceToken !== undefined &&
    item.locked_by_token !== null &&
    item.locked_by_token === holderInstanceToken
  ) {
    const since = item.locked_at !== null ? formatLockedAtHHMM(item.locked_at) : "an unknown time";
    lines.push(
      `  you hold this card's work-lock (since ${since}) -- if only your own part is done, pass locked:false while leaving status:in_progress so the card stays claimed for the rest`
    );
  }
  return lines.join("\n");
}

/**
 * Never echoes the appended content itself.
 * Reports how much was added (header included) and the field's new total size,
 * rather than upsert's requested-vs-landed wording: an append's total is not
 * comparable to the incoming fragment the way an upsert's before/after is.
 * The appended length is computed via buildRoadmapAppendHeader with the same
 * `by` author, since an ISO-8601 timestamp is always 24 chars regardless of
 * instant.
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

// Card 4441e883, team-lead correctif (L3): `locked_at` is either SQLite's
// `datetime('now')` form ("YYYY-MM-DD HH:MM:SS", UTC, no timezone marker) or
// an ISO string ("YYYY-MM-DDTHH:MM:SS.sssZ") -- broker.ts's UPDATE stamps it
// via `COALESCE(?, datetime('now'))`, so an import-path caller can supply
// either shape (same ambiguity `shared/roadmap-lock.ts`'s `parseAsUtcMs`
// normalizes for TTL math). Both forms put HH:MM at the same offset right
// after the date separator, so a plain match extracts it without going
// through `Date` -- parsing a marker-less string with `Date` reads it as
// LOCAL time (V8 behaviour) and would silently shift the displayed hour on
// a non-UTC host, while this string carries no timezone of its own to lose.
function formatLockedAtHHMM(lockedAt: string): string {
  const m = lockedAt.match(/[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : lockedAt;
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

function formatInboundLine(fromPeerId: string, text: string, sentAt: string, recipientRole: string | null): string {
  const label = isOperatorSender(fromPeerId)
    ? OPERATOR_PEER_ID
    : isDeckSender(fromPeerId)
      ? DECK_PEER_ID
      : fromPeerId || "<dormant peer>";
  return `From ${label} (${sentAt}):\n${renderInbound(fromPeerId, text, recipientRole)}`;
}

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;

  // Coverage, not just sensitivity (CLAUDE.md guard-coverage rule): hiding a
  // tool from tools/list alone still leaves it CALLABLE by name, which would
  // make CLAUDE_PEERS_TOOLS decorative. Refuse here too, at the boundary
  // that actually dispatches -- same shape as deck-control-mcp.ts's own
  // tools/call refusal (Card ff091064). Guarded on "known to TOOLS but
  // filtered out", not merely "absent from FILTERED_TOOLS": a name that is
  // not in TOOLS at all (typo, stale client) is a DIFFERENT, pre-existing
  // failure mode and must keep hitting the switch's own `default: throw`
  // below unchanged -- collapsing the two would silently swap that
  // protocol-level error for this tool-result shape for every caller,
  // allow-list or not.
  if (TOOLS.some((t) => t.name === name) && !FILTERED_TOOLS.some((t) => t.name === name)) {
    return {
      content: [{ type: "text" as const, text: `Error: tool not available: ${name}` }],
      isError: true,
    };
  }

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
        // Card e3f8065d / a21f1303: formatInboundLine (above) is the shared
        // enforcer for the "From <name> (<date>):" prefix over renderInbound,
        // now reused by wait_for_message too.
        const lines = result.messages.map((m) => formatInboundLine(m.from_peer_id, m.text, m.sent_at, myRole));
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

    case "wait_for_message": {
      if (!myInstanceToken) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }

      // This case only wires the real peek/timer/cancellation dependencies for
      // runWaitForMessage; the decision logic lives there.
      // One AbortController is shared across all three, aborted by either the
      // timer firing or extra.signal (client cancellation) -- brokerFetch has
      // no signal by default.
      const controller = new AbortController();
      const outcome = await runWaitForMessage(args, {
        peek: async () => {
          try {
            const already = await brokerFetch<PollMessagesResponse>(
              "/peek-messages",
              { instance_token: myInstanceToken },
              controller.signal
            );
            return already.messages;
          } catch (e) {
            // Card a21f1303 U4: a real (non-abort) peek failure must leave a
            // trace -- console.error alone does not count (CLAUDE.md). An
            // abort is expected control flow (the cap or a cancellation),
            // not an error, so it stays silent here.
            if (!controller.signal.aborted) {
              logError("wait_for_message: opportunistic peek failed (falling through to the waiter path)", e);
            }
            throw e;
          }
        },
        notifiedIds: notifiedMessageIds,
        markNotified: (id) => notifiedMessageIds.add(id),
        registerWaiter: (plan, onMatch) => {
          const waiter = buildWaiter(plan, onMatch);
          pendingWaiters.push(waiter);
          return () => {
            pendingWaiters = removeWaiter(pendingWaiters, waiter);
          };
        },
        scheduleTimeout: (ms, onExpire) => {
          const timer = setTimeout(() => {
            controller.abort();
            onExpire();
          }, ms);
          return () => clearTimeout(timer);
        },
        onCancelled: (onCancel) => {
          const handler = () => {
            controller.abort();
            onCancel();
          };
          extra.signal.addEventListener("abort", handler);
          return () => extra.signal.removeEventListener("abort", handler);
        },
      });

      if (outcome.kind === "matched") {
        return {
          content: [
            {
              type: "text" as const,
              text: formatInboundLine(outcome.message.from_peer_id, outcome.message.text, outcome.message.sent_at, myRole),
            },
          ],
        };
      }
      if (outcome.kind === "cancelled") {
        return { content: [{ type: "text" as const, text: "wait_for_message cancelled." }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ timed_out: true }) }] };
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
        // Resolved via roadmapProjectKey(), never a locally recomputed value:
        // /register and roadmap_list scope on that same value, including the
        // local:<hash> fallback for a no-remote repo, so whoami must match what
        // list_peers reports for this session.
        project_key: roadmapProjectKey(),
        group_name: groupNameForId(myGroupId),
        summary: currentSummary,
        registered_at: myRegisteredAt,
        ws_connected: wsConnected,
        role: myRole,
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
          // Card a2f61172: same source as the boot /register below -- both
          // sites must carry this or the role silently disappears on
          // switch_group (their bodies already diverge on claude_cli_pid).
          role: process.env.CLAUDE_PEERS_ROLE,
          // Card 3d121a74 lot L3-a: same two sources as the boot /register
          // below, and the same "both sites or nothing" rule as `role` -- a
          // switch_group that omitted desk_session would silently fall back to
          // the legacy directory-wide key and re-open the shared-row defect
          // for exactly the peers that just changed group. Pinned by a test
          // comparing the two bodies' identity keys as SETS.
          desk_session: process.env.CLAUDE_PEERS_DESK_SESSION,
          cc_session_id: process.env.CLAUDE_CODE_SESSION_ID,
        });
        myInstanceToken = reg.instance_token;
        myPeerId = reg.peer_id;
        myGroupId = newGroupId;
        myRegisteredAt = new Date().toISOString();
        // reg.role can be undefined at runtime -- an older broker omits it from
        // /register entirely, despite the string|null type.
        // Coalesced to null because JSON.stringify drops an undefined key,
        // which would make whoami's role field vanish instead of showing null.
        myRole = reg.role ?? null;
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
                holderInstanceToken: myInstanceToken ?? undefined,
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
          queue: a.queue,
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
                holderInstanceToken: myInstanceToken ?? undefined,
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
            // A GUARDED REQUEST: this tool re-reads its own verdict, so it must
            // never be satisfied by someone else's row (chantier 3189b002).
            merge: "never",
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

    case "roadmap_dispatch": {
      try {
        // One HTTP call: the broker parks the request and holds the response
        // open until the Deck resolves it (wait_sec) -- imitating
        // deck_spawn_session's "wait for the real result, else tell the caller
        // the Deck will announce it". 25 s is two cycles of the Deck's 10 s
        // poller, so a healthy Deck answers inside the wait and a slow one
        // still gets its outcome parked on the row.
        const { request } = await brokerFetch<DispatchRequestAddResponse>(
          "/dispatch-request/add",
          {
            project_key: roadmapProjectKey(),
            by: roadmapAuthor(),
            wait_sec: 25,
            ...roadmapProof(),
          }
        );
        return {
          content: [{ type: "text" as const, text: renderDispatchOutcome(request) }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `roadmap_dispatch failed: ${msg}` }],
          isError: true,
        };
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
          ...roadmapProof(),
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
    // Card a2f61172: same source as the switch_group /register above.
    role: process.env.CLAUDE_PEERS_ROLE,
    // Card 3d121a74 lot L3-a: same two sources as the switch_group /register
    // above (see the note there for why both sites must carry them).
    desk_session: process.env.CLAUDE_PEERS_DESK_SESSION,
    cc_session_id: process.env.CLAUDE_CODE_SESSION_ID,
  });
  myInstanceToken = reg.instance_token;
  myPeerId = reg.peer_id;
  myRegisteredAt = new Date().toISOString();
  // reg.role can be undefined at runtime -- an older broker omits it from
  // /register entirely, despite the string|null type.
  // Coalesced to null because JSON.stringify drops an undefined key, which
  // would make whoami's role field vanish instead of showing null.
  myRole = reg.role ?? null;
  await writePeerIdCache(myCwd, myPeerId);
  // Deck back-channel: hand the real minted session id to the per-tile token file
  // so the Deck maps tile -> session id deterministically (no-op outside the Deck).
  await writeDeskSessionId();
  log(`Registered as peer '${myPeerId}' (instance ${myInstanceToken.slice(0, 8)})`);

  // Background summary upgrade.
  (async () => {
    try {
      const summaryConfig = buildSummaryProviderConfig(config);
      if (summaryConfig.provider !== "none" && !summaryConfig.api_key) {
        log(
          `Summary provider ${summaryConfig.provider} has no API key available; falling back to heuristic summary`
        );
      }
      const summary = await generateSummary(
        { cwd: myCwd, git_root: myGitRoot, git_branch: gitBranch, recent_files: recentFiles },
        summaryConfig
      );
      log(`Summary provider: ${summaryConfig.provider} (model: ${config.summary_model})`);
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
