// Graph drafts: agent-escalated questions parked durably on the broker until
// the operator opens them in the Deck's graph view. Covers create/list/open,
// validation, project_key isolation, and the durability guarantee that
// motivated a dedicated table: listing is NON-destructive (no drain — a Deck
// crash between two polls loses nothing), only /graph-draft/open flips status.
//
// Card 3781b033: /graph-draft/add used to trust project_key AND by straight
// from the request body. Both now come from a proven instance_token lookup
// (resolveProvenGraphDraftPeer, shared/graph-draft-scope.ts, called by
// broker.ts's handleGraphDraftAdd) -- so every add() below registers a real
// peer first and authenticates with its instance_token, mirroring
// tests/broker-roadmap-author-auth.test.ts's `register` helper.
//
// TWO PROOFS, NOT ONE (team-lead instruction, lot 2). This file is the
// WIRING half, local-only like the rest of the broker-*.test.ts family: it
// proves the REAL handler, reached over real HTTP, actually calls the
// resolver and uses its real result -- in particular that a forged by/
// project_key claim in the body is silently overridden by the caller's OWN
// proven identity, not merged with it. The DECISION half (every refusal
// branch of resolveProvenGraphDraftPeer, against an injected fake row
// source) lives in tests/graph-draft-authz.test.ts, which runs in CI because
// it imports no daemon-spawning helper.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import type { GraphDraft, RegisterResponse } from "../shared/types.ts";
import { GRAPH_DRAFT_PROMPT_MAX } from "../shared/graph-draft.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/claude-peers-mcp";
const OTHER_PK = "github.com/vocsap/other-repo";

type AddRes = { draft: GraphDraft };
type ListRes = { drafts: GraphDraft[] };

interface Registered {
  peerId: string;
  token: string;
}

let regCounter = 0;

/** Distinct cwd per call so each registration mints its own peer row/token. */
async function register(projectKey: string): Promise<Registered> {
  regCounter++;
  const res = await post<RegisterResponse>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: `/work/graph-draft-${regCounter}`,
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    client_pid: livePid(),
    project_key: projectKey,
    group_id: "default",
    group_secret_hash: null,
  });
  expect(res.status).toBe(200);
  return { peerId: res.body.peer_id, token: res.body.instance_token };
}

async function add(peer: Registered, fields: Record<string, unknown> = {}): Promise<GraphDraft> {
  const res = await post<AddRes>(`${broker.url}/graph-draft/add`, {
    by: peer.peerId,
    instance_token: peer.token,
    title: "Choix d'architecture",
    prompt: "## Question\nQuelle approche ?",
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.draft;
}

test("add creates a pending draft with author snapshot and timestamps", async () => {
  const peer = await register(PK);
  const draft = await add(peer);
  expect(draft.id.length).toBeGreaterThan(10);
  expect(draft.project_key).toBe(PK);
  expect(draft.from_peer).toBe(peer.peerId);
  expect(draft.status).toBe("pending");
  expect(draft.created_at).toBeTruthy();
  expect(draft.opened_at).toBeNull();
});

// Was "add rejects missing project_key / title / prompt and oversized prompt".
// project_key is no longer a body field the caller controls at all (it is
// derived from the proven instance_token), so the case that used to matter --
// a request with no project_key -- is now "a request with no instance_token",
// and the fix's whole point is that this must be refused (401), not merely
// validated (400). The title/prompt/oversized-prompt cases are unchanged in
// spirit, just now behind a real authenticated caller.
test("add rejects a body with no instance_token (401), and still validates title / prompt / oversized prompt for an authenticated caller (400)", async () => {
  const peer = await register(PK);

  const noToken = await post(`${broker.url}/graph-draft/add`, {
    by: "someone",
    title: "t",
    prompt: "p",
  });
  expect(noToken.status).toBe(401);

  const noTitle = await post(`${broker.url}/graph-draft/add`, {
    by: peer.peerId,
    instance_token: peer.token,
    prompt: "p",
  });
  expect(noTitle.status).toBe(400);

  const noPrompt = await post(`${broker.url}/graph-draft/add`, {
    by: peer.peerId,
    instance_token: peer.token,
    title: "t",
  });
  expect(noPrompt.status).toBe(400);

  const tooLong = await post(`${broker.url}/graph-draft/add`, {
    by: peer.peerId,
    instance_token: peer.token,
    title: "t",
    prompt: "x".repeat(GRAPH_DRAFT_PROMPT_MAX + 1),
  });
  expect(tooLong.status).toBe(400);
});

test("list is non-destructive and isolated by project_key", async () => {
  const minePeer = await register(PK);
  const otherPeer = await register(OTHER_PK);

  const mine = await add(minePeer, { title: "draft A" });
  await add(otherPeer, { title: "other project" });

  const first = await post<ListRes>(`${broker.url}/graph-draft/list`, { project_key: PK });
  expect(first.status).toBe(200);
  const ids = first.body.drafts.map((d) => d.id);
  expect(ids).toContain(mine.id);
  expect(first.body.drafts.every((d) => d.project_key === PK)).toBe(true);

  // The whole point vs the messages drain: listing again returns the SAME
  // pending drafts (a Deck crash between polls loses nothing).
  const second = await post<ListRes>(`${broker.url}/graph-draft/list`, { project_key: PK });
  expect(second.body.drafts.map((d) => d.id)).toEqual(ids);
});

test("open flips to opened exactly once and drops it from the default list", async () => {
  const peer = await register(PK);
  const draft = await add(peer, { title: "to open" });
  const opened = await post<AddRes>(`${broker.url}/graph-draft/open`, { id: draft.id });
  expect(opened.status).toBe(200);
  expect(opened.body.draft.status).toBe("opened");
  expect(opened.body.draft.opened_at).toBeTruthy();

  // Idempotent: reopening keeps the original opened_at.
  const again = await post<AddRes>(`${broker.url}/graph-draft/open`, { id: draft.id });
  expect(again.body.draft.opened_at).toBe(opened.body.draft.opened_at);

  const pending = await post<ListRes>(`${broker.url}/graph-draft/list`, { project_key: PK });
  expect(pending.body.drafts.some((d) => d.id === draft.id)).toBe(false);
  const all = await post<ListRes>(`${broker.url}/graph-draft/list`, {
    project_key: PK,
    include_opened: true,
  });
  expect(all.body.drafts.some((d) => d.id === draft.id)).toBe(true);
});

test("open rejects an unknown id", async () => {
  const res = await post(`${broker.url}/graph-draft/open`, { id: "nope" });
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// WIRING: the real handler, reached over real HTTP, actually calls
// resolveProvenGraphDraftPeer and uses ITS result -- not a text-scan for the
// call, a behavioural probe on the effect (CLAUDE.md's coverage rule: a call
// whose result can be discarded proves nothing).
// ---------------------------------------------------------------------------

test("a proven caller's OWN project_key and identity are used, not a forged claim in the body", async () => {
  const attacker = await register(OTHER_PK);

  // The attacker holds a real, valid instance_token -- for its OWN project --
  // and uses it to try to write into the victim's project, as the victim.
  const res = await post<AddRes>(`${broker.url}/graph-draft/add`, {
    instance_token: attacker.token,
    by: "victim-peer", // forged author claim
    project_key: PK, // forged project claim
    title: "cross-project impersonation attempt",
    prompt: "p",
  });
  expect(res.status).toBe(200);
  // Both forged fields are silently overridden by the proven identity, never
  // merged with it and never causing an outright refusal (a real, honest
  // write from the attacker's own project is legitimate).
  expect(res.body.draft.project_key).toBe(OTHER_PK);
  expect(res.body.draft.project_key).not.toBe(PK);
  expect(res.body.draft.from_peer).toBe(attacker.peerId);
  expect(res.body.draft.from_peer).not.toBe("victim-peer");

  // The victim's own inbox stays empty: the write really landed under the
  // attacker's real project, not merely under a different from_peer.
  const victimList = await post<ListRes>(`${broker.url}/graph-draft/list`, { project_key: PK });
  expect(victimList.body.drafts.some((d) => d.title === "cross-project impersonation attempt")).toBe(false);
});

test("a corrupted instance_token is refused (401), not silently treated as unproven", async () => {
  // A real, valid token from a fresh registration, corrupted by one
  // character -- proves the guard compares the whole value against a real
  // peers row rather than merely checking presence/shape (same technique as
  // tests/broker-roadmap-author-auth.test.ts's "near-miss" probe).
  const peer = await register(PK);
  const corrupted = `${peer.token.slice(0, -1)}${peer.token.endsWith("a") ? "b" : "a"}`;
  expect(corrupted).not.toBe(peer.token);

  const res = await post(`${broker.url}/graph-draft/add`, {
    instance_token: corrupted,
    by: "someone",
    title: "stale token",
    prompt: "p",
  });
  expect(res.status).toBe(401);
});
