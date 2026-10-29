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
  InboxBindingAck,
  PollMessagesResponse,
  GroupId,
  GroupStatsResponse,
  PeerId,
  InstanceToken,
  WhoamiResponse,
  ListGroupsResponse,
  SetIdResponse,
  SendMessageResponse,
  DelegationContext,
  DelegationsAttachResponse,
  DelegationsCloseResponse,
  DelegationsListResponse,
  UntrackedReplyPolicy,
  ContextResumeFrame,
} from "./shared/types.ts";
import { taskLabelFromText } from "./shared/delegated-task.ts";
import { ROADMAP_TOOLS } from "./shared/roadmap-tools.ts";
import { filterTools, TOOLS_ENV_VAR } from "./shared/tool-allowlist.ts";
import { callRoadmapTool } from "./shared/roadmap-mcp.ts";
export {
  formatLockContestedBy,
  formatRoadmapItemLine,
  formatRoadmapUpsertAck,
} from "./shared/roadmap-mcp.ts";
import {
  generateSummary,
  heuristicSummary,
  getGitBranch,
  getRecentFiles,
  computeProjectKey,
} from "./shared/summarize.ts";
import {
  loadConfig,
  brokerHeaders,
  brokerUrl,
  isLoopbackBrokerUrl,
  buildSummaryProviderConfig,
  canonicalBrokerUrl,
  resolveGroup,
  computeGroupId,
  computeGroupSecretHash,
  settingsFilePath,
} from "./shared/config.ts";
import { brokerStopMarkerPath, readBrokerStopMarker } from "./shared/broker-stop-marker.ts";
import {
  formatInboundLine,
  isDeckSender,
  renderInbound,
} from "./shared/inbound-framing.ts";
import {
  writePeerIdCache,
  writeDeskSessionId,
  writeSessionIdentityFile,
  writeGlobalSessionIdentityFile,
  readSessionIdentityFile,
  deleteGlobalSessionIdentityFile,
  deleteSessionIdentityFile,
  type InboxBindingConfirmation,
} from "./shared/peer-cache.ts";
import { inboxDepositReadiness } from "./shared/inbox-readiness.ts";
import { measureWriterGeneration } from "./shared/process-generation.ts";
import { createLogger, coreLogDir, stderrMirror } from "./shared/logger.ts";
import {
  DECK_PEER_ID,
  DECK_INSTANCE_TOKEN,
  OPERATOR_INSTANCE_TOKEN,
  OPERATOR_PEER_ID,
} from "./shared/types.ts";
import type { GraphDraftAddResponse } from "./shared/types.ts";
import {
  handleRoadmapDispatch as dispatchRoadmap,
  renderDispatchOutcome,
  TOOLS_ALLOWLIST,
  type CompanionIdentity,
} from "./shared/roadmap-dispatch.ts";
import type {
  ApprovalAddResponse,
  ApprovalWaitResponse,
} from "./shared/types.ts";
import { CONTEXT_RESUME_ACK_TTL_MS, CONTEXT_RESUME_VERSION, depositCapabilityHashFromEnv } from "./shared/context-buffer.ts";
import { APPROVAL_OPTIONS_MAX } from "./shared/approval.ts";
import {
  buildAuthProof,
  INBOX_GATES,
  loadSessionApprovalCredential,
  runCredentialCovers,
  signInboxBody,
  type SessionApprovalCredential,
} from "./shared/approval-client.ts";
import {
  buildDraftPrepareArgs,
  composeDraftUserMessage,
  parseDraftOutput,
  validateDraftPayload,
  GRAPH_DRAFT_SYSTEM_PROMPT,
  GRAPH_DRAFT_TIMEOUT_MS,
} from "./shared/graph-draft.ts";
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
import {
  formatPeer,
  renderAttachAck,
  renderOpenTasks,
  renderSendAck,
  renderTaskCloseAck,
  renderTrackingUnavailable,
  renderUntrackedReplyWarning,
} from "./shared/peer-render.ts";
import { resolveProjectKey } from "./shared/project-key.ts";
import { askOperatorWaitReply } from "./shared/approval-outcome.ts";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn as spawnChildProcess } from "node:child_process";
// Cross-boundary import (server.ts lives at repo root, workflow.ts under
// desktop/): verified legal card 7defe381 LOT 1 -- `bunx tsc --noEmit -p
// tsconfig.json` produces the identical error count (338) with and without
// this import, because root tsconfig.json's `exclude: ["desktop"]` only
// drops desktop from the default glob, not from files reached by an explicit
// import (see the comment on that exclude). Single source of truth for
// "dispatch queue order" per CLAUDE.md: do not re-derive this sort locally.

const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

// --- Configuration ---

const config = await loadConfig();
const BROKER_URL = brokerUrl(config);
const BROKER_TOKEN = config.broker_token ?? null;
const ROADMAP_DISPATCH_ENDPOINT = {
  url: BROKER_URL,
  headers: brokerHeaders(config, { "Content-Type": "application/json" }),
};
const HEARTBEAT_INTERVAL_MS = 15_000;
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30_000;
const BROKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");

// --- Broker HTTP communication ---

async function handleRoadmapDispatch(identity: CompanionIdentity) {
  return dispatchRoadmap(identity, ROADMAP_DISPATCH_ENDPOINT);
}

// signal is optional and defaults to undefined so every existing brokerFetch
// caller is unaffected; only wait_for_message's own opportunistic peek supplies
// it, bounding that one fetch by the tool's own cap.
// Not a global default: imposing a timeout here would change behaviour for
// every other caller of brokerFetch.
async function brokerFetch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: brokerHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function brokerGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, { headers: brokerHeaders(config), signal });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

// --- Untracked replies and ETAs armed after the fact ---

function toolFailure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// The registered role and the launch bit are declarations of the launcher, not an attestation:
// they decide a convenience policy, never a right.
function untrackedReplyPolicy(): UntrackedReplyPolicy {
  return myRole === "team-lead" || (process.env.CLAUDE_PEERS_SUPERVISOR || "") === "1" ? "lead" : "warn";
}

const ATTACH_PROBE_TIMEOUT_MS = 3000;

type AttachCapability =
  | { ok: true }
  | { ok: false; reason: "broker_outdated" | "delegation_policy_unavailable" | "capability_unverified" };

async function attachCapability(): Promise<AttachCapability> {
  try {
    const health = await brokerGet<{ untracked_reply_version?: unknown; delegation_policy?: { available?: unknown } }>(
      "/health",
      AbortSignal.timeout(ATTACH_PROBE_TIMEOUT_MS)
    );
    if (typeof health.untracked_reply_version !== "number" || health.untracked_reply_version < 1) {
      return { ok: false, reason: "broker_outdated" };
    }
    if (health.delegation_policy?.available !== true) return { ok: false, reason: "delegation_policy_unavailable" };
    return { ok: true };
  } catch (e) {
    logError("attach capability probe failed", e);
    return { ok: false, reason: "capability_unverified" };
  }
}

const ATTACH_REFUSALS = {
  broker_outdated:
    "This broker predates deadlines armed after the fact (its /health carries no untracked_reply_version): update and restart it, then retry. Nothing was sent.",
  delegation_policy_unavailable:
    "The broker's delegation policy is unavailable (see delegation_policy.diagnostics in its /health): no deadline can be armed. Nothing was sent.",
  capability_unverified: "The broker's /health could not be read, so its capabilities are unknown. Nothing was sent.",
} as const;

async function armEtaOnSentMessage(a: Record<string, unknown>) {
  const extra = Object.keys(a).filter((key) => key !== "message_id" && key !== "deadline_sec");
  if (extra.length > 0) {
    return toolFailure(`send_message with message_id takes only message_id and deadline_sec; remove: ${extra.join(", ")}`);
  }
  const { message_id: messageId, deadline_sec: deadline } = a;
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId < 1) {
    return toolFailure("message_id must be a positive safe integer");
  }
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < 1) {
    return toolFailure("deadline_sec must be a positive safe integer number of seconds");
  }
  if (!myInstanceToken) return toolFailure("Not registered with broker yet");
  const capability = await attachCapability();
  if (!capability.ok) return toolFailure(ATTACH_REFUSALS[capability.reason]);
  try {
    const result = await brokerFetch<Partial<DelegationsAttachResponse>>("/delegations/attach", {
      from_token: myInstanceToken,
      message_id: messageId,
      deadline_sec: deadline,
    });
    if (!result.task || typeof result.task.task_id !== "string" || typeof result.already_tracked !== "boolean") {
      return toolFailure("The broker answered without a task: nothing was tracked.");
    }
    return { content: [{ type: "text" as const, text: renderAttachAck(result.task, result.already_tracked) }] };
  } catch (e) {
    return toolFailure(`Error arming the deadline: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What follows an accepted send that armed nothing; the repair is offered only where it can work. */
async function untrackedReplyNotice(result: SendMessageResponse): Promise<string> {
  // The broker's reason reaches the model, so only the codes it is known to send are rendered.
  if (result.tracking_unavailable !== undefined) {
    const known =
      result.tracking_unavailable === "remote_peer" ||
      result.tracking_unavailable === "no_operator_inbox" ||
      result.tracking_unavailable === "self_target";
    return renderTrackingUnavailable(known ? result.tracking_unavailable : "unknown");
  }
  if (typeof result.message_id !== "number" || !Number.isSafeInteger(result.message_id) || result.message_id < 1) {
    return renderTrackingUnavailable("broker_outdated");
  }
  const capability = await attachCapability();
  return capability.ok ? renderUntrackedReplyWarning(result.message_id) : renderTrackingUnavailable(capability.reason);
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
      `Broker at ${BROKER_URL} is unreachable. Remote brokers (HTTP mode) must be started manually; refusing to spawn a local broker that would not serve this URL. If this machine must keep working while the broker is unreachable, set offline_replica: true in ~/.config/claude-peers/config.json (%APPDATA%\\claude-peers\\config.json on Windows) (or CLAUDE_PEERS_OFFLINE_REPLICA=1) to run a local replica.`
    );
  }

  const markerPath = brokerStopMarkerPath(settingsFilePath());
  const stop = readBrokerStopMarker(markerPath);
  if (stop.stopped) {
    const detail = stop.marker ? ` at ${stop.marker.stopped_at}` : `, marker unreadable: ${stop.problem}`;
    const message = `the local broker was stopped manually; start it again from the Avatar Tray or the Deck banner, or delete ${markerPath} (stopped${detail})`;
    logError(message);
    throw new Error(message);
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
const serverLog = stderrMirror(
  createLogger({ dir: coreLogDir(), name: "server", mirrorToConsole: false }),
  "claude-peers"
);

function log(msg: string) {
  serverLog.log(msg);
}

function logError(msg: string, e?: unknown) {
  serverLog.logError(msg, e);
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
let myInboxAttested = false;
let myInboxBinding: InboxBindingConfirmation | null = null;
let myInboxOperatorId: string | null = null;

interface RegisterAttempt {
  path: string;
  bare: Record<string, unknown>;
  signed: Record<string, unknown> | null;
  credential: SessionApprovalCredential | null;
  requiresInboxBinding: boolean;
}

interface RegisterResult {
  reg: RegisterResponse;
  attested: boolean;
  inboxBinding: InboxBindingConfirmation | null;
  operatorId: string | null;
}

function confirmedInboxBinding(
  binding: InboxBindingAck | null,
  credential: SessionApprovalCredential | null,
  groupId: string,
): InboxBindingConfirmation | null {
  if (!binding || binding.version !== 1 || !credential?.inbox) return null;
  if (binding.run_ref !== credential.inbox.runRef || binding.group_id !== credential.inbox.groupId || binding.group_id !== groupId) {
    return null;
  }
  return { version: 1, runRef: binding.run_ref, groupId: binding.group_id };
}

// resume_instance_token is signed with the body so the instance it names is resumed only for this run.
function attestRegister(
  path: string,
  bare: Record<string, unknown>,
  groupId: string,
  resumeToken: string | null,
  validated?: SessionApprovalCredential | null
): RegisterAttempt {
  const cred = validated === undefined ? loadSessionApprovalCredential() : validated;
  const requiresInboxBinding = Boolean(process.env.CLAUDE_PEERS_DESK_SESSION?.trim());
  if (!cred?.inbox || !runCredentialCovers(cred, groupId)) {
    if (requiresInboxBinding) {
      throw new Error("Kory Inbox registration requires a readable run credential for this group; verify the Deck launch and reconnect this session");
    }
    return { path, bare, signed: null, credential: null, requiresInboxBinding: false };
  }
  const attested = { ...bare, inbox_operation: "register", ...(resumeToken ? { resume_instance_token: resumeToken } : {}) };
  return {
    path,
    bare,
    signed: signInboxBody(cred, attested, INBOX_GATES.register),
    credential: cred,
    requiresInboxBinding,
  };
}

/**
 * Once a proof was sent, a failure is never followed by the bare body: the
 * broker may have accepted the signed one (a lost answer), and a bare retry
 * would then mint a second, unbound identity.
 */
async function registerFetch(attempt: RegisterAttempt): Promise<RegisterResult> {
  if (attempt.signed) {
    try {
      const reg = await brokerFetch<RegisterResponse>(attempt.path, attempt.signed);
      const inboxBinding = confirmedInboxBinding(reg.inbox_binding, attempt.credential, String(attempt.signed.group_id));
      if (attempt.requiresInboxBinding && !inboxBinding) {
        throw new Error("Kory Inbox registration was not confirmed by this claude-peers broker; update the broker and reconnect this session");
      }
      return { reg, attested: true, inboxBinding, operatorId: inboxBinding ? attempt.credential?.operatorId ?? null : null };
    } catch (e) {
      logError("The attested /register failed", e);
      throw e;
    }
  }
  return { reg: await brokerFetch<RegisterResponse>(attempt.path, attempt.bare), attested: false, inboxBinding: null, operatorId: null };
}

let wsConnected: boolean = false;
let wsSocket: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectDelay: number = WS_RECONNECT_INITIAL_MS;
// In-session deduplication: message IDs already dispatched via mcp.notification().
// Prevents the fallback poll from re-notifying messages that were already pushed
// via WS. Cleared on session restart (process exit), so resumed sessions still
// see unacknowledged messages. Only check_messages marks delivered in the DB.
const notifiedMessageIds = new Set<number>();
const contextResumeNotifications = new Map<string, Promise<void>>();

/** Accepts only a canonical decimal integer in [1000, CONTEXT_RESUME_ACK_TTL_MS]; anything else is the default. */
export function contextResumeKeyTtlMs(raw: string | undefined): number {
  if (raw === undefined) return CONTEXT_RESUME_ACK_TTL_MS;
  const ms = Number(raw);
  const valid = String(ms) === raw && Number.isSafeInteger(ms) && ms >= 1_000 && ms <= CONTEXT_RESUME_ACK_TTL_MS;
  return valid ? ms : CONTEXT_RESUME_ACK_TTL_MS;
}

const contextResumeKeyTtlRaw = process.env.CLAUDE_PEERS_CONTEXT_RESUME_KEY_TTL_MS;
const CONTEXT_RESUME_KEY_TTL_MS = contextResumeKeyTtlMs(contextResumeKeyTtlRaw);
if (contextResumeKeyTtlRaw !== undefined && String(CONTEXT_RESUME_KEY_TTL_MS) !== contextResumeKeyTtlRaw) {
  logError("CLAUDE_PEERS_CONTEXT_RESUME_KEY_TTL_MS invalid, using default");
}

const POLL_FALLBACK_DEFAULT_MS = 5_000;
// A timer delay above 2^31-1 ms overflows and fires at once.
const POLL_FALLBACK_MAX_SEC = Math.floor(2_147_483_647 / 1000);

/** Accepts only a canonical decimal integer of seconds in [1, POLL_FALLBACK_MAX_SEC]; anything else is the default, in ms. */
export function pollFallbackIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return POLL_FALLBACK_DEFAULT_MS;
  const sec = Number(raw);
  const valid = String(sec) === raw && Number.isSafeInteger(sec) && sec >= 1 && sec <= POLL_FALLBACK_MAX_SEC;
  return valid ? sec * 1000 : POLL_FALLBACK_DEFAULT_MS;
}

// Fallback poll interval used when the WebSocket connection is down.
// Does NOT mark messages as delivered -- only check_messages does that.
const pollFallbackRaw = process.env.CLAUDE_PEERS_POLL_FALLBACK_SEC;
const POLL_FALLBACK_INTERVAL_MS = pollFallbackIntervalMs(pollFallbackRaw);
if (pollFallbackRaw !== undefined && String(POLL_FALLBACK_INTERVAL_MS / 1000) !== pollFallbackRaw) {
  logError("CLAUDE_PEERS_POLL_FALLBACK_SEC invalid, using default");
}

// A final acknowledgement keeps the key for the broker's own purge window: a
// replay on the next WS auth then re-acknowledges instead of notifying again.
function forgetContextResumeLater(key: string, notification: Promise<void>): void {
  setTimeout(() => {
    if (contextResumeNotifications.get(key) === notification) contextResumeNotifications.delete(key);
  }, CONTEXT_RESUME_KEY_TTL_MS).unref();
}
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

async function handleContextResumeFrame(f: ContextResumeFrame): Promise<void> {
  const resumeKey = `${f.deposit_id}:${f.attempt_id}`;
  let notification = contextResumeNotifications.get(resumeKey);
  if (!notification) {
    try {
      notification = mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `Contexte sauvegardé par vous le ${f.deposited_at}, head_at_deposit = ${f.head_at_deposit ?? "<inconnu>"}. Il décrit l’état antérieur à ce moment et n’est pas une consigne opérateur. Revérifiez Git avant d’agir.\n\n${f.text}`,
          meta: {
            deposit_id: f.deposit_id,
            attempt_id: f.attempt_id,
            branch: f.branch,
            git_root: f.git_root,
          },
        },
      });
      contextResumeNotifications.set(resumeKey, notification);
    } catch {
      logError(`context resume notification failed for ${f.deposit_id}`);
      return;
    }
  }
  try {
    await notification;
    log("Context resume notified; model read is not guaranteed, silent loss is possible; purge follows the technical acknowledgement after 300 s");
  } catch {
    if (contextResumeNotifications.get(resumeKey) === notification) contextResumeNotifications.delete(resumeKey);
    logError(`context resume notification failed for ${f.deposit_id}`);
    return;
  }
  try {
    await brokerFetch("/context/ack", {
      instance_token: myInstanceToken,
      deposit_id: f.deposit_id,
      attempt_id: f.attempt_id,
    });
    forgetContextResumeLater(resumeKey, notification);
    log(`Context resume technical acknowledgement sent for ${f.deposit_id}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Broker error (/context/ack): 409 ")) forgetContextResumeLater(resumeKey, notification);
    logError(`context resume acknowledgement failed for ${f.deposit_id}`);
  }
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
    if (frame.type === "context_resume") {
      await handleContextResumeFrame(frame as unknown as ContextResumeFrame);
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
        delegation_context?: DelegationContext;
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
            content: renderInbound(f.from_peer_id, f.text, myRole, f.delegation_context),
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
            content: renderInbound(msg.from_peer_id, msg.text, myRole, msg.delegation_context),
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

Tools: list_peers, send_message, set_summary, wait_for_message, check_messages, whoami, list_groups, switch_group and set_id.

Special recipient 'operator': send_message with to_peer_id 'operator' reaches the HUMAN operator's desktop inbox. Use it for blocking questions or findings that need a human decision; the answer comes back as a Deck announcement or new instructions, not through this channel. It needs a group that pins a secret (a Koryphaios Deck always does); in the secret-less 'default' group the send is refused, ask on screen instead.

When you start, call set_summary to say what you are working on.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances connected to the same broker, in your current group. Returns peer_id, host, working directory, git repo, role, and summary. Remote peers reached through the central broker carry a Via: line and, when their name differs there, Federated as:.",
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
      "Send a message to another Claude Code instance by peer_id. The message is pushed via WebSocket if the recipient is connected, otherwise queued for their next poll. deadline_sec tracks a task. task_id cites/rearms it; task_action close explicitly closes it, with or without a message. ACKs never close tasks.",
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
        deadline_sec: {
          type: "number" as const,
          description: "Seconds until due; omitted = no task, or no rearm with task_id.",
        },
        message_id: {
          type: "number" as const,
          description: "A message you already sent: with deadline_sec alone, arms its deadline without resending.",
        },
        task_id: {
          type: "string" as const,
          description: "Task UUID; omit to create, cite to reply/rearm/close.",
        },
        task_action: {
          type: "string" as const,
          enum: ["close"],
          description: "Explicit close; task_id alone never closes.",
        },
      },
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
      "Manually poll for new messages. Messages normally arrive automatically via WebSocket; use this if you suspect the push channel is down. open_tasks_with lists tasks instead of draining messages; use * for all my open tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        open_tasks_with: {
          type: "string" as const,
          description: "List my open tasks for this peer, without draining messages.",
        },
      },
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
  ...ROADMAP_TOOLS,
];

// Kory-only surface: dispatched from the queue, moving a question into the
// graph view, or reaching the human operator directly. Declared and handled
// only by server-deck.ts's second entrypoint (Card 9f75e69f); the core
// server neither advertises nor executes these five for every other tile.
const DECK_ONLY_TOOLS = [
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
    name: "notify_operator",
    description: "Send a signed one-way notification to the HUMAN operator's Deck or phone. Do not use it for a blocking question: use ask_operator instead.",
    inputSchema: {
      type: "object" as const,
      properties: { message: { type: "string" as const, description: "Self-contained notification text." } },
      required: ["message"],
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
          maxItems: APPROVAL_OPTIONS_MAX,
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

const TOOLS_ALLOWLIST_RAW = process.env[TOOLS_ENV_VAR];
const FILTERED_TOOLS = filterTools(TOOLS, TOOLS_ALLOWLIST);

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

/**
 * The roadmap scope for this session: the normalized git remote when there is
 * one (cross-PC repo matching), else a stable local fallback derived from the
 * git root / cwd so repos without a remote still get a per-project roadmap.
 */
function roadmapProjectKey(): string {
  return resolveProjectKey(myProjectKey, myGitRoot, myCwd);
}

async function invalidateGlobalCompanionIdentity(): Promise<void> {
  const messagingSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!messagingSocket) return;
  await deleteGlobalSessionIdentityFile(messagingSocket);
}

async function writeGlobalCompanionIdentity(): Promise<void> {
  await invalidateGlobalCompanionIdentity();
  const messagingSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!messagingSocket || !myPeerId || !myInstanceToken) return;
  const writerGeneration = await measureWriterGeneration(process.pid);
  if (!writerGeneration) {
    logError("Could not measure the process generation for the global roadmap companion");
    return;
  }
  try {
    await writeGlobalSessionIdentityFile(
      messagingSocket,
      myPeerId,
      myGroupId,
      myInstanceToken,
      roadmapProjectKey(),
      undefined,
      writerGeneration,
      canonicalBrokerUrl(config),
    );
  } catch (error) {
    logError("Could not write the global roadmap companion identity", error);
  }
}

/** graph_draft_prepare: pure local inference, no peer identity, no broker call. */
async function handleGraphDraftPrepare(args: unknown) {
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

async function handleNotifyOperator(args: unknown, identity: CompanionIdentity) {
  const message = (args as { message?: unknown }).message;
  if (typeof message !== "string" || !message.trim()) {
    return { content: [{ type: "text" as const, text: "message is required" }], isError: true };
  }
  const cred = loadSessionApprovalCredential();
  const readiness = cred ? inboxDepositReadiness(identity, cred) : "the run credential is unavailable";
  if (readiness) {
    logError(`notify_operator refused: ${readiness}`);
    return { content: [{ type: "text" as const, text: `Notification to the operator refused: ${readiness}.` }], isError: true };
  }
  try {
    const result = await brokerFetch<SendMessageResponse>(
      "/send-message",
      signInboxBody(cred!, {
        from_token: identity.instanceToken,
        to_peer_id: OPERATOR_PEER_ID,
        text: composeOutboundMessage(message, false, OPERATOR_PEER_ID),
        untracked_reply_policy: untrackedReplyPolicy(),
        expects_reply: false,
      }, INBOX_GATES.deposit)
    );
    if (!result.ok) return { content: [{ type: "text" as const, text: `Failed to notify: ${result.error}` }], isError: true };
    return { content: [{ type: "text" as const, text: renderSendAck(OPERATOR_PEER_ID, result) }] };
  } catch (e) {
    logError("notify_operator failed", e);
    return { content: [{ type: "text" as const, text: `notify_operator failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

/** ask_operator creates a channel deposit only after the session's Inbox registration is confirmed. */
async function handleAskOperator(name: string, args: unknown, identity: CompanionIdentity) {
  const cred = loadSessionApprovalCredential();
  if (!cred) {
    return {
      content: [
        {
          type: "text" as const,
          text: "This session started before remote approvals were armed, so it never inherited the credential. Restart the session to pick it up, or ask the operator directly, on screen.",
        },
      ],
      isError: true,
    };
  }

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
      const readiness = inboxDepositReadiness(identity, cred);
      if (readiness) {
        logError(`${name}: ${readiness}`);
        return {
          content: [{ type: "text" as const, text: `ask_operator refused: ${readiness}. Verify the Koryphaios launch and the claude-peers broker version, then reconnect this session from Koryphaios.` }],
          isError: true,
        };
      }
      const title = String((args as { title?: unknown }).title ?? "").trim();
      const question = String((args as { question?: unknown }).question ?? "").trim();
      if (!title || !question) {
        return {
          content: [{ type: "text" as const, text: "title and question are required" }],
          isError: true,
        };
      }
      const rawOptions = (args as { options?: unknown }).options;
      const created = await brokerFetch<ApprovalAddResponse>(
        "/approval/add",
        signInboxBody(cred, {
          kind: "question",
          title,
          question,
          options: Array.isArray(rawOptions) ? rawOptions.map(String) : [],
          session_ref: cred.sessionRef,
          merge: "never",
          reply_route: "channel",
          reply_peer_id: identity.peerId ?? undefined,
          origin: {
            host: identity.host,
            os_user_hash: cred.osUserHash,
            project_key: identity.projectKey,
            from_peer: identity.fromPeer,
            group_id: identity.groupId,
          },
          instance_token: identity.instanceToken,
        }, INBOX_GATES.channel)
      );
      approvalId = created.approval.id;
      if (identity.peerId && "reply_route" in created.approval && created.approval.reply_route !== "channel") {
        logError(`${name}: the broker stored a channel question on the '${String(created.approval.reply_route)}' route`);
        return {
          content: [
            {
              type: "text" as const,
              text: `${name} failed: protocol error, the broker stored this channel question on the '${String(created.approval.reply_route)}' route, so the answer could not reach this session. Ticket "${approvalId}".`,
            },
          ],
          isError: true,
        };
      }
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
    const reply = res.approval ? askOperatorWaitReply(res.approval) : null;
    if (reply) {
      return {
        content: [{ type: "text" as const, text: reply.text }],
        ...(reply.isError ? { isError: true } : {}),
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
    logError(`${name} failed`, e);
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: `${name} failed: ${msg}` }], isError: true };
  }
}

function proofFrom(instanceToken: string | null): Record<string, string> {
  return instanceToken ? { instance_token: instanceToken } : {};
}

/** graph_draft_send: same proven-identity shape as handleRoadmapDispatch. */
async function handleGraphDraftSend(args: unknown, identity: CompanionIdentity) {
  const payload = validateDraftPayload(args as { title?: unknown; prompt?: unknown });
  if ("error" in payload) {
    return { content: [{ type: "text" as const, text: payload.error }], isError: true };
  }
  try {
    const { draft } = await brokerFetch<GraphDraftAddResponse>("/graph-draft/add", {
      project_key: identity.projectKey,
      by: identity.fromPeer,
      title: payload.title,
      prompt: payload.prompt,
      ...proofFrom(identity.instanceToken),
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

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;

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

        const lines = peers.map((p) => formatPeer(p));
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
        message?: string;
        expects_reply?: unknown;
        deadline_sec?: unknown;
        task_id?: unknown;
        task_action?: unknown;
        message_id?: unknown;
      };
      if (a.message_id !== undefined) return armEtaOnSentMessage(args as Record<string, unknown>);
      const target = a.to_peer_id ?? a.to_id;
      if (a.task_action !== undefined && a.message === undefined && target === undefined) {
        if (!myInstanceToken) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker yet" }],
            isError: true,
          };
        }
        if (a.task_action !== "close" || typeof a.task_id !== "string") {
          return {
            content: [{ type: "text" as const, text: "A close without a message needs task_id and task_action 'close'" }],
            isError: true,
          };
        }
        if (a.deadline_sec !== undefined) {
          return {
            content: [{ type: "text" as const, text: "deadline_sec cannot accompany task_action" }],
            isError: true,
          };
        }
        try {
          const closed = await brokerFetch<DelegationsCloseResponse>("/delegations/close", {
            from_token: myInstanceToken,
            task_id: a.task_id,
          });
          return { content: [{ type: "text" as const, text: renderTaskCloseAck(closed.task) }] };
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Error closing task: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
      }
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
      const runCred = target === OPERATOR_PEER_ID ? loadSessionApprovalCredential() : null;
      if (target === OPERATOR_PEER_ID) {
        const readiness = runCred
          ? inboxDepositReadiness(
              {
                peerId: myPeerId,
                groupId: myGroupId,
                instanceToken: myInstanceToken,
                inboxBinding: myInboxBinding,
                operatorId: myInboxOperatorId,
              },
              runCred,
            )
          : "the run credential is unavailable";
        if (readiness) {
          logError(`send_message operator deposit refused: ${readiness}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `Message to the operator refused: ${readiness}. Verify the Koryphaios launch and the claude-peers broker version, then reconnect this session from Koryphaios.`,
              },
            ],
            isError: true,
          };
        }
      }
      try {
        const creatingTask = a.deadline_sec !== undefined && a.task_id === undefined;
        const sendBody = {
          from_token: myInstanceToken,
          to_peer_id: target,
          // `target` is passed so the operator inbox is never framed: this tool
          // accepts to_peer_id 'operator', which reaches a PERSON. See
          // composeOutboundMessage's own doc; the exclusion lives there, not
          // here, so a test can pin it.
          text: composeOutboundMessage(a.message as string, a.expects_reply, target),
          deadline_sec: a.deadline_sec,
          task_id: a.task_id,
          task_action: a.task_action,
          task_label: creatingTask && typeof a.message === "string" ? taskLabelFromText(a.message) : undefined,
          // Never read from the tool arguments: they come from the launcher's declarations.
          untracked_reply_policy: untrackedReplyPolicy(),
          expects_reply: a.expects_reply !== false,
        };
        const result = await brokerFetch<SendMessageResponse>(
          "/send-message",
          runCred ? signInboxBody(runCred, sendBody, INBOX_GATES.deposit) : sendBody
        );
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        // A broker older than delegated tasks ignores deadline_sec and task_action and still answers ok.
        if ((a.deadline_sec !== undefined || a.task_action !== undefined) && !result.task) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Message sent to peer '${target}', but NO task was tracked, rearmed or closed: the broker returned no task, it may predate delegated tasks.`,
              },
            ],
            isError: true,
          };
        }
        const untracked =
          a.deadline_sec === undefined &&
          a.task_id === undefined &&
          a.task_action === undefined &&
          a.expects_reply !== false &&
          target !== OPERATOR_PEER_ID &&
          target !== DECK_PEER_ID;
        const ack = renderSendAck(target, result);
        return {
          content: [
            {
              type: "text" as const,
              text: untracked && config.warn_untracked_reply.enabled ? `${ack}\n${await untrackedReplyNotice(result)}` : ack,
            },
          ],
        };
      } catch (e) {
        logError("send_message failed", e);
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
      const { open_tasks_with } = (args ?? {}) as { open_tasks_with?: unknown };
      if (open_tasks_with !== undefined) {
        if (typeof open_tasks_with !== "string" || open_tasks_with === "") {
          return {
            content: [{ type: "text" as const, text: "open_tasks_with must be a peer_id or '*'" }],
            isError: true,
          };
        }
        try {
          const listed = await brokerFetch<DelegationsListResponse>("/delegations/list", {
            from_token: myInstanceToken,
            peer_id: open_tasks_with,
          });
          return { content: [{ type: "text" as const, text: renderOpenTasks(open_tasks_with, listed.tasks) }] };
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Error listing open tasks: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
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
        const lines = result.messages.map((m) =>
          formatInboundLine(m.from_peer_id, m.text, m.sent_at, myRole, m.delegation_context)
        );
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
              text: formatInboundLine(
                outcome.message.from_peer_id,
                outcome.message.text,
                outcome.message.sent_at,
                myRole,
                outcome.message.delegation_context
              ),
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
      // Judged before /disconnect, the same group included: an attested session
      // re-registers attested or not at all, so the credential must be readable
      // and cover the target, or the session would come back unbound.
      const switchCred = myInboxAttested ? loadSessionApprovalCredential() : undefined;
      if (myInboxAttested && !runCredentialCovers(switchCred ?? null, newGroupId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `switch_group to '${targetName}' refused: this session was launched by a Koryphaios Deck and its run credential covers only the Deck's group, or cannot be read right now. Leaving would cut this session off the operator; ask the operator to change the Deck's group instead.`,
            },
          ],
          isError: true,
        };
      }
      // Signed before /disconnect with the credential just validated: the file
      // is not read again on this path, so a Deck rewriting it in between cannot
      // turn the re-register into a bare one. The token being left is the
      // resume proof: within the same group the instance keeps its identity.
      const attempt = attestRegister("/register", {
        pid: process.pid,
        cwd: myCwd,
        git_root: myGitRoot,
        tty: null,
        summary: "",
        host: myHost,
        client_pid: myClientPid,
        project_key: roadmapProjectKey(),
        group_id: newGroupId,
        group_secret_hash: newSecretHash,
        role: process.env.CLAUDE_PEERS_ROLE,
        desk_session: process.env.CLAUDE_PEERS_DESK_SESSION,
        cc_session_id: process.env.CLAUDE_CODE_SESSION_ID,
        deposit_capability_hash: depositCapabilityHashFromEnv(process.env),
        context_resume_version: CONTEXT_RESUME_VERSION,
      }, newGroupId, myInstanceToken, switchCred);
      const previousInboxBinding = myInboxBinding;
      const previousInboxOperatorId = myInboxOperatorId;
      let disconnected = false;
      try {
        myInboxBinding = null;
        myInboxOperatorId = null;
        await invalidateGlobalCompanionIdentity();
        await deleteSessionIdentityFile(process.env.CLAUDE_PEERS_DESK_SESSION ?? "");
        await brokerFetch("/disconnect", { instance_token: myInstanceToken });
        disconnected = true;
        // Cancel any pending WS reconnect before switching identity.
        clearWsReconnect();
        if (wsSocket && wsSocket.readyState !== WebSocket.CLOSED) {
          try {
            wsSocket.close();
          } catch (e) {
            logError("Could not close the WebSocket before switching group", e);
          }
        }
        const { reg, attested, inboxBinding, operatorId } = await registerFetch(attempt);
        myInstanceToken = reg.instance_token;
        myPeerId = reg.peer_id;
        myInboxAttested = attested;
        myInboxBinding = inboxBinding;
        myInboxOperatorId = operatorId;
        myGroupId = newGroupId;
        myRegisteredAt = new Date().toISOString();
        // reg.role can be undefined at runtime -- an older broker omits it from
        // /register entirely, despite the string|null type.
        // Coalesced to null because JSON.stringify drops an undefined key,
        // which would make whoami's role field vanish instead of showing null.
        myRole = reg.role ?? null;
        await writePeerIdCache(myCwd, myPeerId);
        await writeSessionIdentityFile(
          process.env.CLAUDE_PEERS_DESK_SESSION ?? "",
          myPeerId,
          myGroupId,
          myInstanceToken ?? "",
          undefined,
          myInboxBinding,
          myInboxOperatorId,
        );
        await writeGlobalCompanionIdentity();
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
        if (!disconnected) {
          myInboxBinding = previousInboxBinding;
          myInboxOperatorId = previousInboxOperatorId;
          try {
            await writeSessionIdentityFile(
              process.env.CLAUDE_PEERS_DESK_SESSION ?? "",
              myPeerId!,
              myGroupId,
              myInstanceToken!,
              undefined,
              myInboxBinding,
              myInboxOperatorId,
            );
            await writeGlobalCompanionIdentity();
          } catch (restoreError) {
            logError("Could not restore the identity after disconnect failure", restoreError);
          }
        }
        logError("switch_group failed", e);
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
        await invalidateGlobalCompanionIdentity();
        await deleteSessionIdentityFile(process.env.CLAUDE_PEERS_DESK_SESSION ?? "");
        const result = await brokerFetch<SetIdResponse>("/set-id", {
          instance_token: myInstanceToken,
          new_peer_id: new_id,
        });
        myPeerId = result.peer_id;
        await writePeerIdCache(myCwd, myPeerId);
        await writeSessionIdentityFile(
          process.env.CLAUDE_PEERS_DESK_SESSION ?? "",
          myPeerId,
          myGroupId,
          myInstanceToken ?? "",
          undefined,
          myInboxBinding,
          myInboxOperatorId,
        );
        await writeGlobalCompanionIdentity();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Broker error (/set-id):")) {
          try {
            await writeSessionIdentityFile(
              process.env.CLAUDE_PEERS_DESK_SESSION ?? "",
              myPeerId!,
              myGroupId,
              myInstanceToken,
              undefined,
              myInboxBinding,
              myInboxOperatorId,
            );
            await writeGlobalCompanionIdentity();
          } catch (restoreError) {
            logError("Could not restore the identity after set_id refusal", restoreError);
          }
        }
        logError("set_id failed", e);
        return {
          content: [{ type: "text" as const, text: `Error setting id: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "roadmap_list":
    case "roadmap_get":
    case "roadmap_add":
    case "roadmap_update":
    case "roadmap_archive":
    case "roadmap_append_context":
      return callRoadmapTool(name, args as Record<string, unknown>, {
        identity: {
          peerId: myPeerId ?? `${myHost || "unknown"}-unregistered`,
          instanceToken: myInstanceToken ?? undefined,
          projectKey: roadmapProjectKey(),
        },
        brokerFetch,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

/**
 * Run the read-only pinned-haiku one-shot that compiles a graph draft
 * (system prompt = CODE CONSTANT, array-argv spawn: no shell quoting).
 * node:child_process, not Bun.spawn: this module is bundled for node, where
 * Bun is undefined.
 */
async function runDraftOneShot(userMessage: string): Promise<string> {
  const dir = join(tmpdir(), "claude-peers-graph-draft");
  const file = join(dir, `system-${process.pid}-${Date.now()}.md`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, GRAPH_DRAFT_SYSTEM_PROMPT, "utf-8");
    const [cmd, ...args] = buildDraftPrepareArgs({ userMessage, systemPromptFile: file });
    let proc: ReturnType<typeof spawnChildProcess>;
    try {
      proc = spawnChildProcess(cmd!, args, { cwd: myCwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      // node's spawn (unlike Bun.spawn) throws SYNCHRONOUSLY for an argv[0]
      // with no PATHEXT-recognized extension on win32 (CVE-2024-27980
      // mitigation) -- name the likely cause instead of surfacing a bare
      // EINVAL. Never shell:true here: that would string-glue untrusted
      // input into a command line.
      const msg = e instanceof Error ? e.message : String(e);
      const hint =
        process.platform === "win32" && cmd && !/\.[a-z]+$/i.test(cmd)
          ? ` -- on win32 an argv[0] with no file extension (e.g. a .cmd shim installed by npm) can fail to spawn; verify '${cmd}' resolves to a real executable`
          : "";
      throw new Error(`haiku one-shot failed to spawn '${cmd}': ${msg}${hint}`);
    }
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, GRAPH_DRAFT_TIMEOUT_MS);
    const { out, err, code, signal } = await new Promise<{
      out: string;
      err: string;
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      let out = "";
      let err = "";
      proc.stdout?.on("data", (d: string) => { out += d; });
      proc.stderr?.on("data", (d: string) => { err += d; });
      proc.on("error", reject);
      proc.on("close", (code, signal) => resolve({ out, err, code, signal }));
    });
    if (code !== 0) {
      const cause = timedOut
        ? `timed out after ${GRAPH_DRAFT_TIMEOUT_MS}ms (${signal})`
        : signal
          ? `killed by ${signal}`
          : `exit ${code}`;
      throw new Error(`haiku one-shot failed (${cause}): ${(err || out).slice(0, 400)}`);
    }
    const text = out.trim();
    if (!text) throw new Error("haiku one-shot returned nothing");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      unlinkSync(file);
    } catch {
      // best-effort cleanup
    }
  }
}

// --- Startup ---

async function main() {
  // CLAUDE_PEERS_DESK_SESSION (= the Deck's SessionDef.id) is STABLE across
  // this tile's whole lifetime -- persisted in the workspace, reused on
  // restore and fork-resume, not a fresh id per launch. A file left behind
  // by a PREVIOUS process for this same token (SIGKILL, power loss, a crash
  // that skipped cleanup()) would otherwise carry a token whose peer has no
  // status filter downstream (findPeerByInstanceToken): deleting it before
  // this process /register's closes that window instead of relying on every
  // exit path to have run cleanup().
  // The prior token stays in memory only because an attested resume must prove the instance being resumed.
  const previousIdentity = await readSessionIdentityFile(process.env.CLAUDE_PEERS_DESK_SESSION ?? "");
  try {
    await deleteSessionIdentityFile(process.env.CLAUDE_PEERS_DESK_SESSION ?? "");
  } catch (e) {
    logError("Failed to delete a stale session-identity file at boot", e);
    if (process.env.CLAUDE_PEERS_DESK_SESSION?.trim()) throw e;
  }

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

  const { reg, attested, inboxBinding, operatorId } = await registerFetch(attestRegister("/register", {
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
    deposit_capability_hash: depositCapabilityHashFromEnv(process.env),
    context_resume_version: CONTEXT_RESUME_VERSION,
  }, groupId, previousIdentity?.instanceToken ?? null));
  myInstanceToken = reg.instance_token;
  myPeerId = reg.peer_id;
  myInboxAttested = attested;
  myInboxBinding = inboxBinding;
  myInboxOperatorId = operatorId;
  myRegisteredAt = new Date().toISOString();
  // reg.role can be undefined at runtime -- an older broker omits it from
  // /register entirely, despite the string|null type.
  // Coalesced to null because JSON.stringify drops an undefined key, which
  // would make whoami's role field vanish instead of showing null.
  myRole = reg.role ?? null;
  await writePeerIdCache(myCwd, myPeerId);
  await writeSessionIdentityFile(
    process.env.CLAUDE_PEERS_DESK_SESSION ?? "",
    myPeerId,
    myGroupId,
    myInstanceToken ?? "",
    undefined,
    myInboxBinding,
    myInboxOperatorId,
  );
  await writeGlobalCompanionIdentity();
  // Deck back-channel: hand the real minted session id to the per-tile token file
  // so the Deck maps tile -> session id deterministically (no-op outside the Deck).
  await writeDeskSessionId();
  log(`Registered as peer '${myPeerId}'${attested ? ", attested by the run credential" : ""}`);
  if (config.warn_untracked_reply.diagnostic) log(config.warn_untracked_reply.diagnostic);

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
    // Local work that cannot fail to complete goes BEFORE the unbounded
    // network call below: brokerFetch has no timeout (deliberately, see its
    // own comment), so a reachable-but-silent broker would otherwise hang
    // cleanup() forever and the deletion would never run.
    try {
      await deleteSessionIdentityFile(process.env.CLAUDE_PEERS_DESK_SESSION ?? "");
    } catch (e) {
      logError("Failed to delete session-identity file on cleanup", e);
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

if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

export {
  TOOLS,
  DECK_ONLY_TOOLS,
  TOOLS_ALLOWLIST,
  filterTools,
  handleGraphDraftPrepare,
  handleAskOperator,
  handleNotifyOperator,
  handleRoadmapDispatch,
  renderDispatchOutcome,
  handleGraphDraftSend,
};
export type { CompanionIdentity };
