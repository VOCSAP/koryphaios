// Dispatch requests (card bf76d37f): an agent asks the Deck to run the head
// wave of the roadmap queue, and the Deck posts back WHAT it dispatched.
//
// Why the outcome is the thing under test and not a nicety: runDirectiveWave
// (desktop/src/main/dispatch.ts) marks a card done BEFORE executing it, so a
// card's `status` acknowledges nothing. The measured failure this card was
// filed for is a lead believing a wave ran because the card said done. So the
// assertions below never stop at "200 OK": they check that what comes back
// names the cards and the tiles, and that a request nobody answered comes back
// visibly PENDING rather than as an empty success.
//
// `broker-` prefix: this file spawns a real broker via startBroker, so it
// belongs to the local-only family (tests/desktop-ci-glob-coverage.test.ts's
// "no non-exempt file real-imports the broker-spawning helper" guard is what
// makes that prefix load-bearing rather than cosmetic).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import type {
  DispatchRequest,
  DispatchRequestOutcome,
  RegisterResponse,
} from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/claude-peers-mcp";
const OTHER_PK = "github.com/vocsap/other-repo";

type AddRes = { request: DispatchRequest };
type ListRes = { requests: DispatchRequest[] };

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
    cwd: `/work/dispatch-request-${regCounter}`,
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

/** Park a request WITHOUT waiting, so the test drives the resolve itself. */
async function park(peer: Registered, fields: Record<string, unknown> = {}): Promise<DispatchRequest> {
  const res = await post<AddRes>(`${broker.url}/dispatch-request/add`, {
    by: peer.peerId,
    instance_token: peer.token,
    wait_sec: 0,
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.request;
}

const OUTCOME: DispatchRequestOutcome = {
  cards: [
    {
      id: "2d8649ce-dcc1-4115-92fb-9d8727756439",
      title: "Purge the reviewers",
      kind: "directive",
      matched: ["reviewer-1", "reviewer-2"],
      missing: ["reviewer-3"],
      ambiguous: ["reviewer-3"],
    },
  ],
  note: "1 card dispatched",
};

test("add parks a pending request stamped with the PROVEN peer, not the body's claims", async () => {
  const peer = await register(PK);
  const request = await park(peer);
  expect(request.id.length).toBeGreaterThan(10);
  expect(request.project_key).toBe(PK);
  expect(request.from_peer).toBe(peer.peerId);
  expect(request.status).toBe("pending");
  expect(request.created_at).toBeTruthy();
  expect(request.resolved_at).toBeNull();
  // The whole point of the card: never an empty success. A parked request
  // carries NO outcome, and the caller can tell that apart from "ran, hit
  // nothing" (which is `status: done` with an empty cards[]).
  expect(request.outcome).toBeNull();
});

test("add refuses a body with no instance_token (401) and a corrupted one (401)", async () => {
  const noToken = await post(`${broker.url}/dispatch-request/add`, { by: "someone", wait_sec: 0 });
  expect(noToken.status).toBe(401);

  // A real token corrupted by ONE character: proves the guard compares the
  // whole value against a real peers row rather than checking presence/shape.
  const peer = await register(PK);
  const corrupted = `${peer.token.slice(0, -1)}${peer.token.endsWith("a") ? "b" : "a"}`;
  expect(corrupted).not.toBe(peer.token);
  const bad = await post(`${broker.url}/dispatch-request/add`, {
    by: peer.peerId,
    instance_token: corrupted,
    wait_sec: 0,
  });
  expect(bad.status).toBe(401);
});

test("a proven caller's OWN project_key is used, so it cannot park against another project's queue", async () => {
  const attacker = await register(OTHER_PK);
  const res = await post<AddRes>(`${broker.url}/dispatch-request/add`, {
    instance_token: attacker.token,
    by: "victim-peer", // forged author claim
    project_key: PK, // forged project claim
    wait_sec: 0,
  });
  expect(res.status).toBe(200);
  expect(res.body.request.project_key).toBe(OTHER_PK);
  expect(res.body.request.from_peer).toBe(attacker.peerId);

  // And it really landed in the attacker's project, not merely under another
  // from_peer: the victim's list never sees it.
  const victim = await post<ListRes>(`${broker.url}/dispatch-request/list`, { project_key: PK });
  expect(victim.body.requests.some((r) => r.id === res.body.request.id)).toBe(false);
});

test("list is non-destructive, project-scoped, and hides resolved requests by default", async () => {
  const peer = await register(PK);
  const request = await park(peer);

  const first = await post<ListRes>(`${broker.url}/dispatch-request/list`, { project_key: PK });
  expect(first.status).toBe(200);
  expect(first.body.requests.some((r) => r.id === request.id)).toBe(true);
  expect(first.body.requests.every((r) => r.project_key === PK)).toBe(true);

  // Park semantics, not drain: the Deck crashing between two polls loses
  // nothing, so a second identical poll returns the same rows.
  const second = await post<ListRes>(`${broker.url}/dispatch-request/list`, { project_key: PK });
  expect(second.body.requests.map((r) => r.id)).toEqual(first.body.requests.map((r) => r.id));

  await post(`${broker.url}/dispatch-request/resolve`, { id: request.id, outcome: OUTCOME });
  const afterResolve = await post<ListRes>(`${broker.url}/dispatch-request/list`, { project_key: PK });
  expect(afterResolve.body.requests.some((r) => r.id === request.id)).toBe(false);
  const withDone = await post<ListRes>(`${broker.url}/dispatch-request/list`, {
    project_key: PK,
    include_done: true,
  });
  expect(withDone.body.requests.some((r) => r.id === request.id)).toBe(true);
});

test("list rejects a missing project_key", async () => {
  const res = await post(`${broker.url}/dispatch-request/list`, {});
  expect(res.status).toBe(400);
});

test("resolve round-trips the whole outcome, buckets included", async () => {
  const peer = await register(PK);
  const request = await park(peer);

  const res = await post<AddRes>(`${broker.url}/dispatch-request/resolve`, {
    id: request.id,
    outcome: OUTCOME,
  });
  expect(res.status).toBe(200);
  expect(res.body.request.status).toBe("done");
  expect(res.body.request.resolved_at).toBeTruthy();
  // Field by field rather than a shape check: an outcome that survives the
  // JSON column but drops `ambiguous` would still be a "done" request, and
  // `ambiguous` is exactly what tells the caller WHY a tile was not hit
  // (commit 73b5e67 refuses a peer_id carried by several live tiles instead
  // of routing to the first one found).
  const card = res.body.request.outcome?.cards[0];
  expect(card?.id).toBe(OUTCOME.cards[0]!.id);
  expect(card?.title).toBe("Purge the reviewers");
  expect(card?.kind).toBe("directive");
  expect(card?.matched).toEqual(["reviewer-1", "reviewer-2"]);
  expect(card?.missing).toEqual(["reviewer-3"]);
  expect(card?.ambiguous).toEqual(["reviewer-3"]);
  expect(res.body.request.outcome?.note).toBe("1 card dispatched");
});

test("resolve is idempotent: a retry returns the stored report, it does not overwrite it", async () => {
  const peer = await register(PK);
  const request = await park(peer);
  const first = await post<AddRes>(`${broker.url}/dispatch-request/resolve`, {
    id: request.id,
    outcome: OUTCOME,
  });
  const second = await post<AddRes>(`${broker.url}/dispatch-request/resolve`, {
    id: request.id,
    outcome: { cards: [], note: "a retry that would have erased the report" },
  });
  expect(second.status).toBe(200);
  expect(second.body.request.resolved_at).toBe(first.body.request.resolved_at);
  expect(second.body.request.outcome?.note).toBe("1 card dispatched");
  expect(second.body.request.outcome?.cards).toHaveLength(1);
});

test("resolve rejects a missing id (400) and an unknown one (404)", async () => {
  expect((await post(`${broker.url}/dispatch-request/resolve`, { outcome: OUTCOME })).status).toBe(400);
  expect(
    (await post(`${broker.url}/dispatch-request/resolve`, { id: "nope", outcome: OUTCOME })).status
  ).toBe(404);
});

test("a hostile outcome is flattened and bounded before it can reach an agent's context", async () => {
  const peer = await register(PK);
  const request = await park(peer);

  // Control bytes built at runtime, never typed as a literal: a literal ESC or
  // NUL in a source file makes git classify the whole file as binary.
  const esc = String.fromCharCode(0x1b);
  const nul = String.fromCharCode(0x00);
  const res = await post<AddRes>(`${broker.url}/dispatch-request/resolve`, {
    id: request.id,
    outcome: {
      note: `${esc}[31mred${nul}\nsecond line`,
      cards: Array.from({ length: 200 }, (_, i) => ({
        id: `card-${i}`,
        title: `${esc}[1mbold`,
        kind: "directive",
        matched: Array.from({ length: 200 }, (_, j) => `peer-${j}`),
        missing: [],
        ambiguous: [],
      })),
    },
  });
  expect(res.status).toBe(200);
  const outcome = res.body.request.outcome!;
  expect(outcome.note).toBe("red second line");
  expect(outcome.note).not.toContain(esc);
  expect(outcome.note).not.toContain(nul);
  expect(outcome.cards).toHaveLength(50);
  expect(outcome.cards[0]!.title).toBe("bold");
  expect(outcome.cards[0]!.matched).toHaveLength(50);
});

test("an unknown extra property is dropped, not projected onward", async () => {
  // Fail-CLOSED rebuild (CLAUDE.md's rest-spread precedent, toPublicPeer): the
  // sanitiser reconstructs every declared field instead of spreading, so a
  // field the Deck invents cannot ride along into the caller's context.
  const peer = await register(PK);
  const request = await park(peer);
  const res = await post<AddRes>(`${broker.url}/dispatch-request/resolve`, {
    id: request.id,
    outcome: {
      note: "n",
      injected_top_level: "should not survive",
      cards: [{ id: "c", title: "t", kind: "k", matched: [], missing: [], ambiguous: [], injected: "x" }],
    },
  });
  expect(res.status).toBe(200);
  const outcome = res.body.request.outcome! as unknown as Record<string, unknown>;
  expect(outcome.injected_top_level).toBeUndefined();
  expect((outcome.cards as Record<string, unknown>[])[0]!.injected).toBeUndefined();
});

test("the long poll returns the REAL outcome when the Deck resolves during the wait", async () => {
  const peer = await register(PK);
  // Deliberately NOT awaited: the request must still be in flight when the
  // resolve lands, or this test would prove nothing about the long poll.
  const inFlight = post<AddRes>(`${broker.url}/dispatch-request/add`, {
    by: peer.peerId,
    instance_token: peer.token,
    wait_sec: 20,
  });

  // Discover the parked id the way the Deck does, by polling the list.
  let parked: DispatchRequest | undefined;
  for (let i = 0; i < 40 && !parked; i++) {
    const list = await post<ListRes>(`${broker.url}/dispatch-request/list`, {
      project_key: PK,
    });
    parked = list.body.requests.find((r) => r.from_peer === peer.peerId);
    if (!parked) await Bun.sleep(50);
  }
  expect(parked).toBeDefined();

  const resolvedAt = Date.now();
  await post(`${broker.url}/dispatch-request/resolve`, { id: parked!.id, outcome: OUTCOME });

  const res = await inFlight;
  const wokeAfterMs = Date.now() - resolvedAt;
  expect(res.status).toBe(200);
  expect(res.body.request.id).toBe(parked!.id);
  // The point: the caller gets the report on the SAME call, without polling.
  expect(res.body.request.status).toBe("done");
  expect(res.body.request.outcome?.cards[0]!.matched).toEqual(["reviewer-1", "reviewer-2"]);
  // MEASURED NECESSITY (2026-09-01). Without this bound the three assertions
  // above stay GREEN when the waiter registry is keyed by anything other than
  // the request id: no waiter is ever found, the long poll runs its full
  // wait_sec, and the TIMEOUT branch then re-reads the durable row and finds
  // the very same resolved outcome. Correct answer, 20 s late -- indis-
  // tinguishable by value, only by time. The bound is what makes this a test
  // of the WAKE-UP and not merely of the durable row (the whole file went from
  // 3.4 s to 41.5 s under that mutation, with 13/13 still passing).
  expect(wokeAfterMs).toBeLessThan(5_000);
}, 30_000);

test("a wait nobody answers returns a visibly PENDING request, never an empty success", async () => {
  const peer = await register(PK);
  const started = Date.now();
  const res = await post<AddRes>(`${broker.url}/dispatch-request/add`, {
    by: peer.peerId,
    instance_token: peer.token,
    wait_sec: 1,
  });
  expect(res.status).toBe(200);
  // It really waited, rather than returning instantly and only LOOKING pending.
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(res.body.request.status).toBe("pending");
  expect(res.body.request.outcome).toBeNull();
  // And it is still parked afterwards: the Deck can answer it late, and the
  // announcement path the tool promises has something to announce about.
  const list = await post<ListRes>(`${broker.url}/dispatch-request/list`, { project_key: PK });
  expect(list.body.requests.some((r) => r.id === res.body.request.id)).toBe(true);
}, 15_000);

test("two concurrent waits wake independently: one resolve settles ONLY its own request", async () => {
  // Keyed by request id, not by project_key. Two leads triggering on one
  // project is the normal case, and the failure shape this guards against is
  // the repo's recurring one (CLAUDE.md): a registry keyed by too little, so
  // the second waiter silently receives the first one's answer -- or nothing.
  const a = await register(PK);
  const b = await register(PK);
  const inFlightA = post<AddRes>(`${broker.url}/dispatch-request/add`, {
    by: a.peerId,
    instance_token: a.token,
    wait_sec: 20,
  });
  const inFlightB = post<AddRes>(`${broker.url}/dispatch-request/add`, {
    by: b.peerId,
    instance_token: b.token,
    wait_sec: 2,
  });

  let parkedA: DispatchRequest | undefined;
  let parkedB: DispatchRequest | undefined;
  for (let i = 0; i < 40 && !(parkedA && parkedB); i++) {
    const list = await post<ListRes>(`${broker.url}/dispatch-request/list`, { project_key: PK });
    parkedA = list.body.requests.find((r) => r.from_peer === a.peerId);
    parkedB = list.body.requests.find((r) => r.from_peer === b.peerId);
    if (!(parkedA && parkedB)) await Bun.sleep(25);
  }
  expect(parkedA).toBeDefined();
  expect(parkedB).toBeDefined();
  expect(parkedA!.id).not.toBe(parkedB!.id);

  const resolvedAt = Date.now();
  await post(`${broker.url}/dispatch-request/resolve`, {
    id: parkedA!.id,
    outcome: { cards: [], note: "only A" },
  });

  const [resA, resB] = await Promise.all([inFlightA, inFlightB]);
  // Same reason as the latency bound in the test above: A's wait_sec is 20, so
  // without this A would still answer correctly -- from the timeout re-read --
  // under a registry keyed by the wrong thing.
  expect(Date.now() - resolvedAt).toBeLessThan(5_000);
  expect(resA.body.request.id).toBe(parkedA!.id);
  expect(resA.body.request.status).toBe("done");
  expect(resA.body.request.outcome?.note).toBe("only A");
  // B was never resolved: it must time out pending, NOT inherit A's report.
  expect(resB.body.request.id).toBe(parkedB!.id);
  expect(resB.body.request.status).toBe("pending");
  expect(resB.body.request.outcome).toBeNull();
}, 30_000);
