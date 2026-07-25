import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  deriveTokenId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";
import type { Approval } from "../shared/types.ts";

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
    ...payload,
    public_key: signer.cred.publicKey,
  };
  const auth = buildAuthProof(signer.cred.privateKey, body, {
    kind,
    operator_id: signer.operator_id,
    token_id: signer.token_id,
  });
  return post<T>(`${b.url}${path}`, { ...body, auth });
}

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
      origin: { host: "bureau", project_key: "github.com/vocsap/koryphaios" },
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
    const approval = await addApproval(b, op);

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
      {},
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
      {},
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
    await addApproval(b, op, { origin: { host: "bureau", project_key: "p" } });
    await addApproval(b, op, { origin: { host: "portable", project_key: "p" } });

    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      {},
      { cred: op.cred, operator_id: op.id }
    );
    expect(list.body.approvals).toHaveLength(2);
    expect(new Set(list.body.approvals.map((a) => a.origin.host))).toEqual(
      new Set(["bureau", "portable"])
    );
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
      {},
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
      { undelivered_only: true },
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
      { undelivered_only: true },
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
