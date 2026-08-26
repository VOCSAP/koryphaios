// Card 3781b033, lot 2 (team-lead ruling, 2026-08-26). Decision logic pulled
// out of broker.ts's resolveProvenGraphDraftPeer into a pure module so it can
// be unit-tested in CI against a fake peers-row source, WITHOUT importing
// tests/_helper.ts's startBroker -- doing that from a non-`broker-`/`server-`
// prefixed test file trips tests/desktop-ci-glob-coverage.test.ts's
// "card b33b1874: no non-exempt file real-imports the broker-spawning
// helper" guard, which is exactly what happened to the first version of
// tests/graph-draft-authz.test.ts. Mirrors shared/approval-scope.ts's
// ApprovalAuthDeps.queryOne injection pattern for the identical reason: keep
// this file out of the broker's module graph (importing it spawns no
// daemon), and make the decision layer runnable in CI on its own.
//
// TWO PROOFS, NOT ONE (team-lead instruction). Extracting the DECISION here
// makes its CALL SITE invisible to a suite that only exercises this module --
// this repo measured 12 of 13 wiring mutations staying green against a fully
// passing pure-module suite the same week this card shipped. So the WIRING
// probe (does handleGraphDraftAdd in broker.ts actually call this, with the
// real request, and use its real result) stays a separate, local-only,
// behavioural test against the live broker in
// tests/broker-graph-drafts.test.ts. This module's own test file
// (tests/graph-draft-authz.test.ts) proves only the DECISION, against an
// injected fake, and is what actually runs in CI as a result.
//
// WHAT THIS CLOSES, EXACTLY: ATTRIBUTION, not SCOPE. from_peer and
// project_key below both come from the matched `peers` ROW, never from the
// request body -- an attacker cannot forge WHO it is or WHICH of its own
// registered projects it acts under, and a corrupted/unknown/sentinel token
// is refused rather than falling through to an unproven default. What this
// does NOT close (team-lead audit, 2026-08-26, measured): the peers.project_key
// COLUMN ITSELF is populated by /register from a caller-declared value with
// no ownership check and no charset/homoglyph normalization -- an attacker
// can register claiming the victim's project_key verbatim (including a
// homoglyph or an embedded control character) and this module will then
// correctly, faithfully report that forged value back as "this peer's own"
// project_key, because it IS what that peer's row says. Same class of
// residual as docs/DESIGN-APPROVAL-SCOPE.md's G3 on a sibling table, and
// exactly why card 3781b033's own commentary says this closes the ROUTE and
// not the FAMILY (card c92614ed carries the wider closure).

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
 * THE SINGLE PRODUCER of a proven (peer_id, project_key) pair for
 * /graph-draft/add. Deliberately NOT built on resolveRoadmapAuthor
 * (broker.ts): that helper's reserved-name/operator-signed branch answers
 * "who is the author" for a signed 'deck' write with no `peers` row at all,
 * and therefore no project_key to give -- correct for the roadmap, where a
 * signed operator write is a real, supported caller, but this route needs a
 * PROVEN project_key unconditionally and has no signed-write path of its own
 * to support. A reserved peer_id reaching this function (a legacy row
 * registered before mint-time refused the name) is refused outright below,
 * with a set_id remedy, rather than offered a signature path this route does
 * not have.
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
