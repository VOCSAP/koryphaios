#!/usr/bin/env bun
/**
 * claude-peers MCP server (v0.7.0)
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
import { createHash } from "node:crypto";
import type {
  Peer,
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
import { writePeerIdCache, writeDeskSessionId } from "./shared/peer-cache.ts";
import { DECK_PEER_ID, DECK_INSTANCE_TOKEN } from "./shared/types.ts";

const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

// --- Deck announcements (v0.3.4) ---
// Messages whose sender is the reserved 'deck' sentinel are one-way operator
// broadcasts. They must NOT trigger the default channel behaviour ("RESPOND
// IMMEDIATELY / reply with send_message"). Since that instruction is global (not
// per-message), the no-reply guarantee is carried inside the rendered content,
// and reinforced by the sender being non-routable (send_message to 'deck' fails).
// English wording for maximum model compatibility.
const DECK_NO_REPLY_NOTE =
  '\n\n[claude-peers] Informational only -- do NOT reply and do not call send_message toward "deck". Take it into account in your work if relevant.';

function isDeckSender(idOrToken: string): boolean {
  return idOrToken === DECK_PEER_ID || idOrToken === DECK_INSTANCE_TOKEN;
}

function renderDeckAnnouncement(text: string): string {
  return `[Deck announcement -- operator broadcast]\n${text}${DECK_NO_REPLY_NOTE}`;
}

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

function log(msg: string) {
  console.error(`[claude-peers] ${msg}`);
}

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
            content: fromDeck ? renderDeckAnnouncement(f.text) : f.text,
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
    // Best-effort resolution of from_token -> Peer for richer notification meta.
    let tokenToPeer = new Map<string, Peer>();
    try {
      const peers = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        instance_token: myInstanceToken,
        cwd: myCwd,
        git_root: myGitRoot,
        project_key: myProjectKey,
      });
      tokenToPeer = new Map(peers.map((p) => [p.instance_token, p]));
    } catch { /* non-fatal */ }
    for (const msg of fresh) {
      const fromDeck = isDeckSender(msg.from_token);
      const peer = tokenToPeer.get(msg.from_token);
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: fromDeck ? renderDeckAnnouncement(msg.text) : msg.text,
            meta: {
              from_peer_id: fromDeck ? DECK_PEER_ID : (peer?.peer_id ?? msg.from_token),
              from_summary: peer?.summary ?? "",
              from_cwd: peer?.cwd ?? "",
              from_host: peer?.host ?? "",
              sent_at: msg.sent_at,
            },
          },
        });
        notifiedMessageIds.add(msg.id);
      } catch { /* fire-and-forget */ }
    }
  } catch { /* non-fatal */ }
}

// --- MCP server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.7.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine and on other PCs sharing the same broker can see you and send you messages, scoped to your current group.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message with the from_peer_id, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder -- answer right away, even if you're in the middle of something.

Available tools:
- list_peers: Discover other Claude Code instances in your group (scope: machine/directory/repo).
- send_message: Send a message to another instance by peer_id.
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers in your group).
- check_messages: Manually check for new messages (polling fallback; messages normally arrive via WebSocket push).
- whoami: Show your current peer_id, group, host, cwd, and WebSocket status.
- list_groups: Show available groups defined in user config and how many active peers each has.
- switch_group: Move this session to another group (disconnect + re-register).
- set_id: Rename your peer_id within the current group (display name only; routing is unchanged).
- roadmap_list / roadmap_get / roadmap_add / roadmap_update / roadmap_archive: the project's shared roadmap (see below).

Special recipient 'operator': send_message with to_peer_id 'operator' reaches the HUMAN operator's desktop inbox (works even though 'operator' is not in list_peers). Use it for blocking questions or important findings that need a human decision. The operator does not reply through this channel -- expect an answer as a deck announcement or new instructions.

This project also has a SHARED ROADMAP: a persistent backlog of features, bugs, tech debt and ideas, scoped to this repository (not to your group or session) and shared with every Claude instance working on it, now and in future sessions. Use it actively:
- At the start of a task, call roadmap_list to see what is planned and in progress.
- When you discover a bug, tech debt or a good idea outside your current task, record it with roadmap_add instead of letting it vanish with the session.
- ALWAYS fill the 'context' field when you add an item: it is the implementation briefing for the agent that will pick the item up later, in a fresh session with none of your current knowledge. Cover the objective, constraints / scope boundaries, pointers to the relevant files/modules/tests, acceptance criteria, and decisions already made -- especially what a fresh session cannot rediscover by exploring the repo (e.g. "the bug is in flushPendingForToken, cross-host reconnect case, see broker-flush-cap.test.ts").
- Keep the status of items you work on up to date (roadmap_update: planned -> in_progress -> done), and enrich an item's context with roadmap_update when you learn something the next agent will need.

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
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
    description:
      "List the project's shared roadmap items (persistent backlog scoped to this repository, shared across sessions and groups). Optional filters. Archived items are hidden unless requested.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string" as const,
          enum: ["feature", "bug", "debt", "idea", "chore"],
          description: "Only items of this kind.",
        },
        status: {
          type: "string" as const,
          enum: ["idea", "planned", "in_progress", "done", "archived"],
          description: "Only items in this status.",
        },
        priority: {
          type: "string" as const,
          enum: ["must", "should", "could", "wont"],
          description: "Only items with this MoSCoW priority.",
        },
        tag: { type: "string" as const, description: "Only items carrying this tag." },
        include_archived: {
          type: "boolean" as const,
          description: "Include archived items (default false).",
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
  {
    name: "roadmap_add",
    description:
      "Add an item to the project's shared roadmap. Use it to record features, bugs, tech debt or ideas so they survive this session. Only title is required; sensible defaults apply (kind=feature, priority=could, value/effort=medium, status=idea).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short imperative title." },
        kind: {
          type: "string" as const,
          enum: ["feature", "bug", "debt", "idea", "chore"],
          description: "Item kind (default feature).",
        },
        description: { type: "string" as const, description: "Free markdown details." },
        rationale: { type: "string" as const, description: "Why it matters (business value)." },
        context: {
          type: "string" as const,
          description:
            "Implementation briefing for the agent that will pick this item up later, in a FUTURE session with none of your current context. Cover: objective, constraints / scope boundaries (what NOT to touch), pointers to the relevant files/modules/tests, acceptance criteria, and decisions already made. Write what a fresh session cannot rediscover by exploring the repo.",
        },
        priority: {
          type: "string" as const,
          enum: ["must", "should", "could", "wont"],
          description: "MoSCoW priority (default could).",
        },
        value: {
          type: "string" as const,
          enum: ["low", "medium", "high"],
          description: "Impact / value (default medium).",
        },
        effort: {
          type: "string" as const,
          enum: ["low", "medium", "high"],
          description: "Complexity / effort (default medium).",
        },
        status: {
          type: "string" as const,
          enum: ["idea", "planned", "in_progress", "done"],
          description: "Initial status (default idea).",
        },
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Free tags (e.g. component, milestone).",
        },
        depends_on: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Ids of items this one depends on.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "roadmap_update",
    description:
      "Partially update a roadmap item: only the fields you pass change. Use it to move status (planned -> in_progress -> done), reprioritize, retag or rewrite. Accepts a full id or a unique prefix. Setting status=archived archives; any other status restores an archived item.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
        title: { type: "string" as const },
        kind: { type: "string" as const, enum: ["feature", "bug", "debt", "idea", "chore"] },
        description: { type: "string" as const },
        rationale: { type: "string" as const },
        context: {
          type: "string" as const,
          description:
            "Implementation briefing for the agent that will pick this item up later (objective, constraints, file pointers, acceptance criteria, decisions made). Replaces the whole field.",
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

function formatPeer(p: Peer): string {
  const statusLabel = { active: "🟢 active", sleep: "🟡 sleep", closed: "🔴 closed" }[p.activity_status];
  const idLine = p.host && p.client_pid
    ? `peer_id: ${p.peer_id}  (${p.host} - PID: ${p.client_pid})`
    : `peer_id: ${p.peer_id}`;
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
  if (myProjectKey) return myProjectKey;
  const anchor = myGitRoot ?? myCwd;
  return `local:${createHash("sha256").update(anchor, "utf-8").digest("hex").slice(0, 16)}`;
}

/** Author stamp for roadmap writes: the resolved peer_id, else a host fallback. */
function roadmapAuthor(): string {
  return myPeerId ?? `${myHost || "unknown"}-unregistered`;
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
  return `[${i.id.slice(0, 8)}] ${i.kind} · ${i.priority} · value:${i.value} effort:${i.effort} · ${i.status} — ${i.title}${tags}`;
}

function formatRoadmapItemDetail(i: RoadmapItem): string {
  const lines = [
    `${formatRoadmapItemLine(i)}`,
    `id: ${i.id}`,
    i.description ? `description: ${i.description}` : "",
    i.rationale ? `rationale: ${i.rationale}` : "",
    i.context ? `context (agent briefing): ${i.context}` : "",
    i.depends_on.length ? `depends_on: ${i.depends_on.map((d) => d.slice(0, 8)).join(", ")}` : "",
    `created: ${i.created_at} by ${i.created_by}`,
    `updated: ${i.updated_at} by ${i.updated_by}`,
    i.deleted_at ? `archived: ${i.deleted_at}` : "",
  ].filter(Boolean);
  return lines.join("\n  ");
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
        const peers = await brokerFetch<Peer[]>("/list-peers", {
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
      const a = args as { to_peer_id?: string; to_id?: string; message: string };
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
          text: a.message,
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
        // Resolve from_token -> from_peer_id by listing peers in the group.
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          instance_token: myInstanceToken,
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
        });
        const tokenToId = new Map(peers.map((p) => [p.instance_token, p.peer_id]));
        const lines = result.messages.map((m) => {
          if (isDeckSender(m.from_token)) {
            return `From ${DECK_PEER_ID} (${m.sent_at}):\n${renderDeckAnnouncement(m.text)}`;
          }
          const peerId = tokenToId.get(m.from_token) ?? "<dormant peer>";
          return `From ${peerId} (${m.sent_at}):\n${m.text}`;
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
        const peers = await brokerFetch<Peer[]>("/list-peers", {
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
        project_key: myProjectKey,
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
          project_key: myProjectKey,
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
      };
      try {
        const { items } = await brokerFetch<RoadmapListResponse>("/roadmap/list", {
          project_key: roadmapProjectKey(),
          kind: a.kind,
          status: a.status,
          priority: a.priority,
          tag: a.tag,
          include_archived: a.include_archived ?? false,
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
        // Group by MoSCoW priority for a scannable overview.
        const order = ["must", "should", "could", "wont"] as const;
        const blocks = order
          .map((p) => {
            const rows = items.filter((i) => i.priority === p);
            if (rows.length === 0) return "";
            return `${p.toUpperCase()} (${rows.length}):\n${rows.map(formatRoadmapItemLine).join("\n")}`;
          })
          .filter(Boolean);
        return {
          content: [
            {
              type: "text" as const,
              text: `${items.length} roadmap item(s):\n\n${blocks.join("\n\n")}\n\nUse roadmap_get <id> for details, roadmap_update to change status.`,
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
        });
        return {
          content: [
            { type: "text" as const, text: `Roadmap item created:\n${formatRoadmapItemDetail(item)}` },
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
        });
        return {
          content: [
            { type: "text" as const, text: `Roadmap item updated:\n${formatRoadmapItemDetail(item)}` },
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

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
    project_key: myProjectKey,
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
