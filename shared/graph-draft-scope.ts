// from_peer and project_key are read from the matched peers row, never the
// request body -- a caller cannot forge who it is or which of its own
// registered projects it acts under, and an unknown/corrupted/sentinel token is
// refused rather than defaulting.
// Does not close: the peers.project_key column itself is populated by /register
// from a caller-declared value with no ownership check or homoglyph
// normalization, so a forged project_key is faithfully reported back as that
// peer's own.

import { isSentinelInstanceToken, RESERVED_PEER_IDS } from "./types.ts";

export interface GraphDraftAuthError {
  error: string;
  status: number;
}

export type GraphDraftAuthResult<T> = T | GraphDraftAuthError;

export function isGraphDraftAuthError(v: unknown): v is GraphDraftAuthError {
  return typeof v === "object" && v !== null && "error" in v;
}

/** The two columns this decision needs from a matched `peers` row. */
export interface GraphDraftPeerRow {
  peer_id: string;
  project_key: string | null;
}

/** A peer identity proven by instance_token, ready to stamp a graph draft. */
export interface ProvenGraphDraftPeer {
  peerId: string;
  projectKey: string | null;
}

/** Everything this module needs from the broker, so it imports no database. */
export interface GraphDraftScopeDeps {
  findPeerByInstanceToken(token: string): GraphDraftPeerRow | null;
}

/**
 * Deliberately not built on resolveRoadmapAuthor: that helper also answers for
 * a signed operator write with no peers row and therefore no project_key, which
 * this route has no equivalent path for -- it needs a proven project_key
 * unconditionally.
 * A reserved peer_id reaching here (a legacy row registered before mint-time
 * refused the name) is refused outright with a set_id remedy.
 */
export function resolveProvenGraphDraftPeer(
  deps: GraphDraftScopeDeps,
  body: { instance_token?: unknown },
  route: string,
  onRefusal?: (message: string, meta?: Record<string, unknown>) => void
): GraphDraftAuthResult<ProvenGraphDraftPeer> {
  const token = typeof body.instance_token === "string" ? body.instance_token.trim() : "";
  if (!token) {
    return { error: "instance_token is required", status: 401 };
  }
  if (isSentinelInstanceToken(token)) {
    onRefusal?.(`${route}: refused a reserved sentinel instance_token (public constant, not a credential)`);
    return { error: "instance_token is a reserved sentinel", status: 403 };
  }
  const owner = deps.findPeerByInstanceToken(token);
  if (!owner) {
    onRefusal?.(`${route}: refused an unknown instance_token`);
    return { error: "unknown instance_token", status: 401 };
  }
  if (RESERVED_PEER_IDS.includes(owner.peer_id)) {
    onRefusal?.(`${route}: refused a token whose peer_id is a reserved identity`, { peer_id: owner.peer_id });
    return {
      error: `peer_id '${owner.peer_id}' is a reserved identity and cannot author a graph draft. This peer was registered before reserved names were refused: call set_id with a normal name, then retry.`,
      status: 403,
    };
  }
  return { peerId: owner.peer_id, projectKey: owner.project_key };
}
