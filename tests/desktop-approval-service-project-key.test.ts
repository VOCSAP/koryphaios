// mintSessionToken, addApproval, claimApproval and markVerdictsDelivered must
// each put project_key in their outgoing HTTP body -- a compile-time-required
// struct field does not guarantee it reaches the JSON.
// mintSessionToken enforces this via its own check in broker.ts, not the shared
// resolveProjectKey gate the other three share.
// fetchPendingApprovals fires two independent requests (status:'pending' and
// status:'expired_notif'), so each is checked addressably, not just one of the
// two.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  addApproval,
  claimApproval,
  fetchPendingApprovals,
  fetchUndeliveredVerdicts,
  markVerdictsDelivered,
  mintSessionToken,
  type ApprovalDeps
} from "../desktop/src/main/approval-service.ts";
import { generateCredential, deriveOperatorId } from "../shared/approval.ts";

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

let calls: CapturedCall[];

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
    host: "host-y"
  });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url.endsWith("/approval/add")).toBe(true);
  expect(calls[0]!.body.project_key).toBe("proj-add");
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
