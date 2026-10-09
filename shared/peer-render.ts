/**
 * Pure text rendering shared by the MCP tools of server.ts: the peer block of
 * `list_peers` and the acknowledgement of `send_message`. Kept free of any
 * broker or process state so a test can pin the exact strings the model reads.
 */

import type { DelegatedTask, PublicPeer, SendMessageResponse } from "./types.ts";

export function formatElapsed(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const elapsed = now - new Date(iso).getTime();
  const mins = Math.floor(elapsed / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * A duration in the same buckets as formatElapsed but without the "ago":
 * seconds under a minute (the federation grace is counted in seconds), then
 * minutes, hours and days. Negative or non-finite input reads as 0s.
 */
export function formatDuration(ms: number): string {
  const secs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatPeer(p: PublicPeer, now: number = Date.now()): string {
  const statusLabel = { active: "🟢 active", sleep: "🟡 sleep", closed: "🔴 closed" }[p.activity_status];
  const idLine = p.host ? `peer_id: ${p.peer_id}  (${p.host})` : `peer_id: ${p.peer_id}`;
  const parts = [`${statusLabel}  ${idLine}`, `CWD: ${p.cwd}`];
  if (p.role) parts.push(`Role: ${p.role}`);
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.project_key) parts.push(`Project: ${p.project_key}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  if (p.via) {
    // The client only says since when the link is down: the broker owns the
    // grace and hides the peer once it expires, so no "left" is computed here.
    const linkDown = p.link_down_since
      ? ` (link down for ${formatDuration(now - new Date(p.link_down_since).getTime())})`
      : "";
    const origin = p.via === "upstream" ? "upstream broker" : `replica ${p.via}`;
    parts.push(`Via: ${origin}${linkDown}`);
  }
  if (p.upstream_peer_id && p.upstream_peer_id !== p.peer_id) {
    parts.push(`Federated as: ${p.upstream_peer_id}`);
  }
  parts.push(`Last exchange: ${formatElapsed(p.last_activity_at, now)}`);
  return parts.join("\n  ");
}

/**
 * The text of a SUCCESSFUL send_message. A queued response (replica whose
 * upstream link is down, within the federation grace) tells the sender how
 * long the broker can still hold the message; a grace that is absent or not a
 * finite number is never rendered as "NaN min".
 */
function describeDue(dueAtMs: number | null): string {
  return dueAtMs === null ? "no deadline" : `due ${new Date(dueAtMs).toISOString()}`;
}

function describeTask(task: DelegatedTask): string {
  return `task ${task.task_id} ${JSON.stringify(task.label)}`;
}

export function renderSendAck(
  target: string,
  response: Pick<SendMessageResponse, "queued" | "grace_left_sec" | "task">
): string {
  const task = response.task;
  if (task) {
    if (task.status === "closed") return `Message sent to peer '${target}'; ${describeTask(task)} is closed.`;
    return `Message sent to peer '${target}'; tracked ${describeTask(task)}, ${describeDue(task.due_at_ms)}, rearms used ${task.rearm_count}/${task.policy.max_rearms}.`;
  }
  if (!response.queued) return `Message sent to peer '${target}'`;
  const grace = response.grace_left_sec;
  const window = typeof grace === "number" && Number.isFinite(grace)
    ? `within ${Math.max(1, Math.ceil(grace / 60))} min`
    : "before the federation grace expires";
  return `Message to peer '${target}' queued: the central broker is unreachable, it will be delivered if the link returns ${window}, otherwise dropped and you will be told.`;
}

/** The result of a close without a message: nothing was sent. */
export function renderTaskCloseAck(task: DelegatedTask): string {
  return `No message sent; ${describeTask(task)} is closed.`;
}

export function renderOpenTasks(peerFilter: string, tasks: readonly DelegatedTask[]): string {
  const scope = peerFilter === "*" ? "" : ` with '${peerFilter}'`;
  if (tasks.length === 0) return `No open tasks you delegated${scope}.`;
  const lines = tasks.map(
    (t) =>
      `- ${describeTask(t)} to '${t.delegate_peer_id}', ${describeDue(t.due_at_ms)}, status ${t.status}, rearms used ${t.rearm_count}/${t.policy.max_rearms}`
  );
  return `${tasks.length} open task(s) you delegated${scope}:\n${lines.join("\n")}`;
}
