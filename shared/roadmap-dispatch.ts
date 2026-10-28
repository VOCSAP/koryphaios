import type { InboxBindingConfirmation } from "./peer-cache.ts";
import type { DispatchRequest, DispatchRequestAddResponse } from "./types.ts";

export const PEER_TOOLS_ENV_VAR = "CLAUDE_PEERS_TOOLS";

export function resolveToolAllowlist(envValue: string | undefined): string[] | null {
  if (envValue === undefined) return null;
  if (envValue === "") return [];
  return envValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export const TOOLS_ALLOWLIST = resolveToolAllowlist(process.env[PEER_TOOLS_ENV_VAR]);

export interface CompanionIdentity {
  host: string;
  peerId: string | null;
  groupId: string;
  instanceToken: string | null;
  inboxBinding: InboxBindingConfirmation | null;
  operatorId: string | null;
  projectKey: string;
  fromPeer: string;
}

export interface DispatchBrokerEndpoint {
  url: string;
  headers: Record<string, string>;
}

async function dispatchFetch<T>(endpoint: DispatchBrokerEndpoint, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${endpoint.url}${path}`, {
    method: "POST",
    headers: endpoint.headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Broker error (${path}): ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

export function renderDispatchOutcome(request: DispatchRequest): string {
  if (request.status !== "done" || !request.outcome) {
    return `Dispatch requested (id ${request.id}) — the Deck had not answered within the wait. The request is PARKED broker-side, not lost: the Deck runs it and announces the outcome on this channel. Do not assume it ran.`;
  }
  const { cards, note } = request.outcome;
  if (cards.length === 0) {
    return `Dispatch ran, and dispatched NOTHING${note ? `: ${note}` : "."} Nothing in the queue was eligible, so no tile was touched.`;
  }
  const lines = cards.map((card) => {
    const parts = [`  - [${card.id.slice(0, 8)}] ${card.kind}: ${card.title}`];
    parts.push(`    hit: ${card.matched.length > 0 ? card.matched.join(", ") : "(none)"}`);
    if (card.missing.length > 0) parts.push(`    NOT hit: ${card.missing.join(", ")}`);
    if (card.ambiguous.length > 0) {
      parts.push(`    refused as ambiguous (several live tiles share the id): ${card.ambiguous.join(", ")}`);
    }
    const refused = card.refused ?? [];
    if (refused.length > 0) {
      parts.push(`    refused: ${refused.map(({ peerId, reason }) => `${peerId} (${reason})`).join(", ")}`);
    }
    const pending = card.pending ?? [];
    if (pending.length > 0) parts.push(`    pending: ${pending.join(", ")}`);
    return parts.join("\n");
  });
  return `Dispatch ran. ${cards.length} card(s) dispatched:\n${lines.join("\n")}${note ? `\n${note}` : ""}`;
}

export async function handleRoadmapDispatch(identity: CompanionIdentity, endpoint: DispatchBrokerEndpoint) {
  try {
    const { request } = await dispatchFetch<DispatchRequestAddResponse>(endpoint, "/dispatch-request/add", {
      project_key: identity.projectKey,
      by: identity.fromPeer,
      wait_sec: 25,
      ...(identity.instanceToken ? { instance_token: identity.instanceToken } : {}),
    });
    return {
      content: [{ type: "text" as const, text: renderDispatchOutcome(request) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `roadmap_dispatch failed: ${message}` }],
      isError: true,
    };
  }
}
