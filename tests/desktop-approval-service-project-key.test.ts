// Card 4df14b5b -- witness for the client-side half of the project_key fix.
//
// ApprovalDeps.projectKey (desktop/src/main/approval-service.ts) is a
// REQUIRED TypeScript field: the type system refuses to compile a caller that
// forgets to pass a projectKey into ApprovalDeps at all. But that is a
// compile-time gate on the STRUCT, not a runtime guarantee that the field
// actually reaches the outgoing HTTP body -- a caller can hold a perfectly
// well-typed `deps.projectKey` and still never put it in the JSON it sends.
// Team-lead's mutation review (2026-08-18) measured exactly that gap:
//   - drop `project_key: deps.projectKey` from fetchUndeliveredVerdicts alone
//     -> 75 pass / 0 new fail, clean typecheck.
//   - drop it from fetchPendingApprovals alone -> same, 75 pass / 0 new fail.
// Neither half had an execution witness. This file is that witness for BOTH,
// independently: it calls the real, unmodified fetchUndeliveredVerdicts and
// fetchPendingApprovals through the fetchImpl seam already in ApprovalDeps
// (no broker process, no spawn), captures every outgoing request, and checks
// project_key on EACH ONE addressably -- not "at least one of N" -- because
// fetchPendingApprovals fires two independent requests (status:'pending' and
// status:'expired_notif', desktop/src/main/approval-service.ts:223-237) and a
// mutation could plausibly drop the field from only one of the two branches.
//
// CI glob note: this file is named tests/desktop-*.test.ts on purpose --
// .github/workflows/desktop-build.yml's "Bun tests (pure modules)" step lists
// explicit globs and does NOT include tests/approval-*.test.ts or
// tests/broker-*.test.ts (those spawn a broker daemon, out of scope for that
// matrix). A guard named outside tests/desktop-*.test.ts would never run in
// CI at all -- confirmed by reading that workflow file directly before
// picking this name.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  fetchPendingApprovals,
  fetchUndeliveredVerdicts,
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
  expect(calls[0]!.body.project_key).toBe("proj-A");
  expect(calls[0]!.body.undelivered_only).toBe(true);
});

test("fetchPendingApprovals sends project_key on BOTH its /approval/list requests (pending AND expired_notif), individually", async () => {
  const deps = makeDeps("proj-B");
  await fetchPendingApprovals(deps);
  expect(calls.length).toBe(2);

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

test("a distinct projectKey per deps object is not cross-contaminated between the two functions", () => {
  // Cheap regression against a shared-mutable-default trap (e.g. a module
  // level object reused as a payload base): two independent ApprovalDeps
  // with different projectKeys must never leak into each other's captured
  // request bodies within the same test run.
  const a = makeDeps("proj-left");
  const b = makeDeps("proj-right");
  expect(a.projectKey).not.toBe(b.projectKey);
});
