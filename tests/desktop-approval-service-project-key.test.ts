import { afterEach, beforeEach, expect, test } from "bun:test";
import * as approvalService from "../desktop/src/main/approval-service.ts";
import {
  addApproval,
  BrokerHttpError,
  claimApproval,
  settleAnsweredInTerminal,
  ackApproval,
  fetchPendingApprovals,
  fetchUndeliveredVerdicts,
  markVerdictsDelivered,
  mintSessionToken,
  type ApprovalDeps
} from "../desktop/src/main/approval-service.ts";
import { generateCredential, deriveOperatorId, INBOX_GATES, verifyInboxProof } from "../shared/approval.ts";

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

let calls: CapturedCall[];
const renewSessionToken = Reflect.get(approvalService, "renewSessionToken") as typeof mintSessionToken | undefined;

function fakeFetchImpl(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ approvals: [] })
    } as unknown as Response;
  }) as typeof fetch;
}

function makeDeps(projectKey: string): ApprovalDeps {
  // A REAL ed25519 keypair is required: signedPost's buildAuthProof() calls
  // node:crypto's createPrivateKey({format:'der', type:'pkcs8', ...}) on
  // deps.identity.privateKey before the fetchImpl is ever reached, so a
  // fabricated placeholder string throws there instead of exercising the
  // path this test actually cares about.
  const cred = generateCredential();
  return {
    endpoint: { url: "http://127.0.0.1:0", token: null },
    identity: {
      operatorId: deriveOperatorId(cred.publicKey),
      publicKey: cred.publicKey,
      privateKey: cred.privateKey,
      osUserHash: "test-host"
    },
    projectKey,
    fetchImpl: fakeFetchImpl()
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  calls = [];
});

test("fetchUndeliveredVerdicts sends project_key on its single /approval/list request", async () => {
  const deps = makeDeps("proj-A");
  await fetchUndeliveredVerdicts(deps);
  expect(calls.length).toBe(1);
  // Route is checked alongside body: a well-formed body sent to the wrong
  // endpoint (e.g. the destructive /approval/delivered) would otherwise pass
  // silently.
  expect(calls[0]!.url.endsWith("/approval/list")).toBe(true);
  expect(calls[0]!.body.project_key).toBe("proj-A");
  expect(calls[0]!.body.undelivered_only).toBe(true);
});

test("fetchPendingApprovals sends project_key on BOTH its /approval/list requests (pending AND expired_notif), individually", async () => {
  const deps = makeDeps("proj-B");
  await fetchPendingApprovals(deps);
  expect(calls.length).toBe(2);
  // Every captured call is checked, not just one: a mutation routing only the
  // expired_notif branch to a different endpoint would otherwise pass silently.
  expect(calls.every((c) => c.url.endsWith("/approval/list"))).toBe(true);

  const pendingCall = calls.find((c) => c.body.status === "pending");
  const expiredCall = calls.find((c) => c.body.status === "expired_notif");
  expect(pendingCall).toBeTruthy();
  expect(expiredCall).toBeTruthy();

  // Addressed separately on purpose: a mutation dropping project_key from
  // only ONE of the two status branches must still be caught here, not
  // masked by the other branch still carrying it.
  expect(pendingCall!.body.project_key).toBe("proj-B");
  expect(expiredCall!.body.project_key).toBe("proj-B");
});

test("a distinct projectKey per deps object is not cross-contaminated between the two functions", async () => {
  // Regression against a shared-mutable-default trap (e.g. a module level
  // object reused as a payload base): two independent ApprovalDeps with
  // different projectKeys must never leak into each other's captured request
  // bodies within the same test run. MUST run production code and inspect the
  // captured request bodies -- asserting only "proj-left" !== "proj-right" on
  // the struct fields (previous version of this test) measures nothing:
  // no mutation of approval-service.ts could ever make it fail.
  const a = makeDeps("proj-left");
  const b = makeDeps("proj-right");
  await fetchUndeliveredVerdicts(a);
  await fetchUndeliveredVerdicts(b);
  expect(calls.length).toBe(2);
  expect(calls[0]!.body.project_key).toBe("proj-left");
  expect(calls[1]!.body.project_key).toBe("proj-right");
});

test("mintSessionToken sends project_key on its /approval/token-mint request", async () => {
  const deps = makeDeps("proj-mint");
  await mintSessionToken(deps, { sessionPublicKey: "session-pub-x", sessionRef: "session-x" });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url.endsWith("/approval/token-mint")).toBe(true);
  expect(calls[0]!.body.project_key).toBe("proj-mint");
});

test("renewSessionToken sends renew_only and project_key on its /approval/token-mint request", async () => {
  expect(renewSessionToken).toBeTypeOf("function");
  const deps = makeDeps("proj-renew");
  await renewSessionToken!(deps, { sessionPublicKey: "session-pub-renew", sessionRef: "session-renew" });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url.endsWith("/approval/token-mint")).toBe(true);
  expect(calls[0]!.body).toMatchObject({
    session_public_key: "session-pub-renew",
    session_ref: "session-renew",
    project_key: "proj-renew",
    ttl_hours: 24,
    renew_only: true
  });
});

test("addApproval sends project_key TOP-LEVEL on its /approval/add request", async () => {
  const deps = makeDeps("proj-add");
  await addApproval(deps, {
    kind: "question",
    title: "t",
    question: "q?",
    sessionRef: "session-y",
    // Deliberately different from the origin's own descriptive project_key
    // field, which the broker does not read for enforcement.
    // Using distinct values here proves the assertion below reads the top-level
    // field the broker actually enforces, not this decoy.
    projectKey: "origin-decoy",
    host: "host-y",
    merge: "tile"
  });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url.endsWith("/approval/add")).toBe(true);
  expect(calls[0]!.body.project_key).toBe("proj-add");
});

test("addApproval sends tile_only only when the answer belongs on the tile", async () => {
  const base = { kind: "question", title: "t", question: "q?", sessionRef: "s", projectKey: "p", host: "h", merge: "tile" } as const;
  await addApproval(makeDeps("proj-tile-only"), { ...base, tileOnly: true });
  await addApproval(makeDeps("proj-tile-only"), { ...base, tileOnly: false });
  await addApproval(makeDeps("proj-tile-only"), base);
  expect(calls[0]!.body.tile_only, "mutation: drop the spread of tile_only").toBe(true);
  expect("tile_only" in calls[1]!.body, "a false flag is not sent: an older broker sees today's body").toBe(false);
  expect("tile_only" in calls[2]!.body).toBe(false);
});

test("claimApproval sends project_key on its /approval/claim request", async () => {
  const deps = makeDeps("proj-claim");
  await claimApproval(deps, { id: "appr-1", answerKind: "allow" });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url.endsWith("/approval/claim")).toBe(true);
  expect(calls[0]!.body.project_key).toBe("proj-claim");
});

test("markVerdictsDelivered sends project_key on its /approval/delivered request", async () => {
  const deps = makeDeps("proj-deliver");
  await markVerdictsDelivered(deps, ["id-1", "id-2"]);
  expect(calls.length).toBe(1);
  expect(calls[0]!.url.endsWith("/approval/delivered")).toBe(true);
  expect(calls[0]!.body.project_key).toBe("proj-deliver");
});

test("the list and delivered calls name this window's run, on every request", async () => {
  const deps = { ...makeDeps("proj-run"), runRef: "3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b" };
  await fetchUndeliveredVerdicts(deps);
  await fetchPendingApprovals(deps);
  await markVerdictsDelivered(deps, ["id-1"]);
  expect(calls.map((c) => [new URL(c.url).pathname, c.body.run_ref])).toEqual([
    ["/approval/list", deps.runRef],
    ["/approval/list", deps.runRef],
    ["/approval/list", deps.runRef],
    ["/approval/delivered", deps.runRef]
  ]);
});

test("an Inbox mint and its renewal carry the inbox block under a v1 proof for the mint door", async () => {
  const deps = makeDeps("proj-inbox");
  const inbox = { version: 1, kind: "run", run_ref: "3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b", group_id: "g" } as const;
  await mintSessionToken(deps, { sessionPublicKey: "pub", sessionRef: "window-x", inbox });
  await renewSessionToken!(deps, { sessionPublicKey: "pub", sessionRef: "window-x", inbox } as never);
  for (const call of calls) {
    expect(call.body.inbox).toEqual(inbox);
    const { auth, ...payload } = call.body;
    expect(verifyInboxProof(deps.identity.publicKey, payload, auth as never, INBOX_GATES.mint).ok, "v1 proof for the mint door").toBe(true);
  }
  expect(calls[1]!.body.renew_only).toBe(true);
});

test("signOperatorBody binds a v1 proof to the door it is given, never to another", () => {
  const deps = makeDeps("proj-door");
  const body = { group_id: "g", run_ref: "r", session_id: "s" };
  const proof = approvalService.signOperatorBody(deps.identity, body, INBOX_GATES.drain);
  expect(proof.kind).toBe("operator");
  expect(verifyInboxProof(deps.identity.publicKey, body, proof, INBOX_GATES.drain).ok).toBe(true);
  expect(verifyInboxProof(deps.identity.publicKey, body, proof, INBOX_GATES.purge).ok).toBe(false);
});

test("a refused claim surfaces the broker's reason to the operator, status last", async () => {
  const answering = (status: number, body: string): typeof fetch =>
    (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const deps = makeDeps("proj-claim");
  const reason = "the session is no longer waiting for this answer (closed or restarted): answer it in its terminal";

  const gone = claimApproval(
    { ...deps, fetchImpl: answering(410, JSON.stringify({ error: reason })) },
    { id: "a", answerKind: "allow" }
  );
  const goneError = await gone.catch((error: unknown) => error);
  expect(goneError, "a status other than 409 must remain an error").toBeInstanceOf(BrokerHttpError);
  expect(goneError).toMatchObject({
    path: "/approval/claim",
    status: 410,
    detail: reason
  });
  expect(goneError).toMatchObject({ message: `/approval/claim failed: ${reason}: 410` });
  expect(String(goneError)).toBe(`Error: /approval/claim failed: ${reason}: 410`);

  const raw = claimApproval({ ...deps, fetchImpl: answering(502, "Bad Gateway") }, { id: "a", answerKind: "allow" });
  await expect(raw).rejects.toThrow("/approval/claim failed: Bad Gateway: 502");

  const empty = claimApproval({ ...deps, fetchImpl: answering(500, "") }, { id: "a", answerKind: "allow" });
  await expect(empty).rejects.toThrow(/^\/approval\/claim failed: 500$/);

  const lost = await claimApproval(
    { ...deps, fetchImpl: answering(409, JSON.stringify({ error: "already-settled" })) },
    { id: "a", answerKind: "allow" }
  );
  expect(lost, "a lost race still reads as null once the reason is in the message").toBeNull();
});

test("settleAnsweredInTerminal treats only HTTP 409 as already settled", async () => {
  const answering = (status: number): typeof fetch =>
    (async () => new Response(JSON.stringify({ error: "already-settled" }), { status })) as unknown as typeof fetch;
  const deps = makeDeps("proj-terminal-answer");

  await expect(settleAnsweredInTerminal({ ...deps, fetchImpl: answering(409) }, "a")).resolves.toBeNull();
  await expect(settleAnsweredInTerminal({ ...deps, fetchImpl: answering(410) }, "a")).rejects.toBeInstanceOf(BrokerHttpError);
});

test("ackApproval treats only HTTP 409 as already settled", async () => {
  const answering = (status: number): typeof fetch =>
    (async () => new Response(JSON.stringify({ error: "already-settled" }), { status })) as unknown as typeof fetch;
  const deps = makeDeps("proj-ack");

  await expect(ackApproval({ ...deps, fetchImpl: answering(409) }, "a")).resolves.toBeNull();
  await expect(ackApproval({ ...deps, fetchImpl: answering(410) }, "a")).rejects.toBeInstanceOf(BrokerHttpError);
});
