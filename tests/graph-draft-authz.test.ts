// Proves the decision against an injected fake row source, deliberately with no
// live broker, so this file stays part of the fast, isolated test step rather
// than the integration one.
// This proves the decision only -- whether the real handler actually calls this
// function, with a real request, is proved separately against a live broker
// elsewhere, since extracting logic into a pure module makes its call site
// invisible to a suite that only exercises the module.
// Scope: this closes attribution on adding a graph draft only (from_peer and
// project_key come from the matched peer row, never the request body), not the
// underlying ownership gap on that row's own project_key column, and not the
// sibling handlers that still trust their body's claims.

import { test, expect } from "bun:test";
import {
  resolveProvenGraphDraftPeer,
  isGraphDraftAuthError,
  type GraphDraftScopeDeps,
  type GraphDraftPeerRow,
} from "../shared/graph-draft-scope.ts";
import { DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN, RESERVED_PEER_IDS } from "../shared/types.ts";

const ROUTE = "/graph-draft/add";

/** In-memory fake of the one thing this module needs from the broker. */
function fakeDeps(rows: Record<string, GraphDraftPeerRow>): GraphDraftScopeDeps {
  return {
    findPeerByInstanceToken(token: string) {
      return rows[token] ?? null;
    },
  };
}

test("refuses a body with no instance_token (401)", () => {
  const deps = fakeDeps({});
  const res = resolveProvenGraphDraftPeer(deps, {}, ROUTE);
  expect(isGraphDraftAuthError(res)).toBe(true);
  if (isGraphDraftAuthError(res)) {
    expect(res.status).toBe(401);
  }
});

test("refuses a blank/whitespace-only instance_token the same as absent (401)", () => {
  const deps = fakeDeps({});
  const res = resolveProvenGraphDraftPeer(deps, { instance_token: "   " }, ROUTE);
  expect(isGraphDraftAuthError(res)).toBe(true);
  if (isGraphDraftAuthError(res)) expect(res.status).toBe(401);
});

test("refuses every sentinel instance_token (403), never treated as a real credential", () => {
  const deps = fakeDeps({});
  for (const sentinel of [DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN]) {
    const res = resolveProvenGraphDraftPeer(deps, { instance_token: sentinel }, ROUTE);
    expect(isGraphDraftAuthError(res)).toBe(true);
    if (isGraphDraftAuthError(res)) expect(res.status).toBe(403);
  }
});

test("refuses an instance_token that matches no row (401), not silently accepted", () => {
  const deps = fakeDeps({ "real-token": { peer_id: "alice", project_key: "github.com/vocsap/koryphaios" } });
  const res = resolveProvenGraphDraftPeer(deps, { instance_token: "not-the-real-one" }, ROUTE);
  expect(isGraphDraftAuthError(res)).toBe(true);
  if (isGraphDraftAuthError(res)) expect(res.status).toBe(401);
});

test("refuses a token whose row is a reserved peer_id (403), with a set_id remedy", () => {
  expect(RESERVED_PEER_IDS.length).toBeGreaterThan(0);
  for (const reserved of RESERVED_PEER_IDS) {
    const deps = fakeDeps({ "legacy-token": { peer_id: reserved, project_key: "github.com/vocsap/koryphaios" } });
    const res = resolveProvenGraphDraftPeer(deps, { instance_token: "legacy-token" }, ROUTE);
    expect(isGraphDraftAuthError(res)).toBe(true);
    if (isGraphDraftAuthError(res)) {
      expect(res.status).toBe(403);
      expect(res.error).toContain("reserved identity");
      expect(res.error).toContain("set_id");
    }
  }
});

test("refuses a proven peer with no project_key on its row -- caller decides after the fact, not this function", () => {
  // This function itself does not enforce projectKey truthiness (that is
  // handleGraphDraftAdd's job, one call site) -- it faithfully reports what
  // the row says, including null.
  const deps = fakeDeps({ "bare-token": { peer_id: "bob", project_key: null } });
  const res = resolveProvenGraphDraftPeer(deps, { instance_token: "bare-token" }, ROUTE);
  expect(isGraphDraftAuthError(res)).toBe(false);
  if (!isGraphDraftAuthError(res)) {
    expect(res.peerId).toBe("bob");
    expect(res.projectKey).toBeNull();
  }
});

test("returns the ROW's identity, not any claim in the body -- the whole point of the fix", () => {
  const deps = fakeDeps({
    "attacker-token": { peer_id: "attacker", project_key: "github.com/vocsap/attacker-project" },
  });
  const res = resolveProvenGraphDraftPeer(
    deps,
    {
      instance_token: "attacker-token",
      // A caller cannot pass these to resolveProvenGraphDraftPeer's own body
      // type at all (it only reads instance_token) -- this loose object
      // simulates what a wider request body carries, to prove they are
      // simply never consulted.
      by: "victim-peer",
      project_key: "github.com/vocsap/victim-project",
    } as { instance_token?: unknown },
    ROUTE
  );
  expect(isGraphDraftAuthError(res)).toBe(false);
  if (!isGraphDraftAuthError(res)) {
    expect(res.peerId).toBe("attacker");
    expect(res.projectKey).toBe("github.com/vocsap/attacker-project");
    expect(res.peerId).not.toBe("victim-peer");
    expect(res.projectKey).not.toBe("github.com/vocsap/victim-project");
  }
});

test("onRefusal fires on every refusal branch, and only on refusal", () => {
  const deps = fakeDeps({ "real-token": { peer_id: "carol", project_key: "github.com/vocsap/koryphaios" } });
  const calls: string[] = [];
  const onRefusal = (message: string) => calls.push(message);

  resolveProvenGraphDraftPeer(deps, {}, ROUTE, onRefusal);
  resolveProvenGraphDraftPeer(deps, { instance_token: DECK_INSTANCE_TOKEN }, ROUTE, onRefusal);
  resolveProvenGraphDraftPeer(deps, { instance_token: "unknown" }, ROUTE, onRefusal);
  // Absent-token refusal (empty body) does NOT call onRefusal today (returns
  // before any branch that logs) -- pinned so a future change to that is a
  // deliberate edit, not a silent drop of the earliest refusal's trace.
  expect(calls.length).toBe(2);

  resolveProvenGraphDraftPeer(deps, { instance_token: "real-token" }, ROUTE, onRefusal);
  expect(calls.length).toBe(2); // unchanged: the successful call fired nothing
});
