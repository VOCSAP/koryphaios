// Acknowledging a blocking question: the operator read it and has nothing to
// add. The agent must be able to tell that apart from a refusal, on every
// surface that reads a settled approval back.

import { test, expect, describe, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, approvalListBody, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";
import { askOperatorWaitReply, settledOutcome } from "../shared/approval-outcome.ts";
import { renderSettled } from "../notify/format.ts";
import type { Approval } from "../shared/types.ts";

const brokers: TestBroker[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  for (const b of brokers) await stopBroker(b);
});

type Operator = { cred: ApprovalCredential; id: string };

function newOperator(): Operator {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
}

async function signedPost<T>(
  b: TestBroker,
  path: string,
  payload: Record<string, unknown>,
  op: Operator
): Promise<{ status: number; body: T }> {
  const body = { project_key: "p", ...payload, public_key: op.cred.publicKey };
  const auth = buildAuthProof(op.cred.privateKey, body, { kind: "operator", operator_id: op.id });
  return post<T>(`${b.url}${path}`, { ...body, auth });
}

async function connectPeer(b: TestBroker, cwd: string): Promise<{ peerId: string; frames: unknown[] }> {
  const reg = await post<{ peer_id: string; instance_token: string }>(`${b.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    client_pid: 1,
    project_key: null,
    group_id: "default",
    group_secret_hash: null,
  });
  expect(reg.status).toBe(200);
  const frames: unknown[] = [];
  const ws = new WebSocket(b.wsUrl);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: reg.body.instance_token }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    setTimeout(() => reject(new Error("ws open timeout")), 5000);
  });
  ws.addEventListener("message", (ev) => {
    try {
      frames.push(JSON.parse(String(ev.data)));
    } catch {
      /* ignore non-JSON */
    }
  });
  await Bun.sleep(200);
  return { peerId: reg.body.peer_id, frames };
}

function messageTexts(frames: unknown[], approvalId: string): string[] {
  return frames
    .filter((f): f is { type: string; text: string } =>
      typeof f === "object" && f !== null && (f as { type?: string }).type === "message"
    )
    .map((f) => String(f.text))
    .filter((text) => text.includes(approvalId));
}

async function waitForApprovalMessage(frames: unknown[], approvalId: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const hit = messageTexts(frames, approvalId)[0];
    if (hit !== undefined) return hit;
    await Bun.sleep(100);
  }
  throw new Error(`no channel message for approval ${approvalId} (got ${JSON.stringify(frames)})`);
}

async function raise(b: TestBroker, op: Operator, extra: Record<string, unknown>): Promise<Approval> {
  const res = await signedPost<{ approval: Approval }>(
    b,
    "/approval/add",
    {
      kind: "question",
      title: "Finding",
      question: "Read this, nothing is blocked.",
      origin: { host: "test-host", project_key: "p", group_id: "default" },
      merge: "never",
      ...extra,
    },
    op
  );
  expect(res.status).toBe(200);
  return res.body.approval as Approval;
}

async function waitOn(b: TestBroker, op: Operator, id: string): Promise<Approval> {
  const res = await signedPost<{ approval?: Approval }>(b, "/approval/wait", { id, timeout_sec: 1 }, op);
  expect(res.status).toBe(200);
  expect(res.body.approval).toBeDefined();
  return res.body.approval!;
}

async function pendingIds(b: TestBroker, op: Operator): Promise<string[]> {
  const list = await signedPost<{ approvals: Approval[] }>(
    b,
    "/approval/list",
    { ...approvalListBody("p"), status: "pending" },
    op
  );
  expect(list.status).toBe(200);
  return list.body.approvals.map((a) => a.id);
}

describe("acknowledging a channel-route question", () => {
  test("ack and deny reach the agent as two distinguishable outcomes", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/ack-proj-a");

    const acked = await raise(b, op, { reply_route: "channel", reply_peer_id: peer.peerId, tile_ref: "t-ack" });
    const declined = await raise(b, op, { reply_route: "channel", reply_peer_id: peer.peerId, tile_ref: "t-deny" });
    expect([acked.reply_route, declined.reply_route]).toEqual(["channel", "channel"]);

    const ackRes = await signedPost<{ approval: Approval }>(
      b,
      "/approval/claim",
      { id: acked.id, via: "deck", acknowledge: true },
      op
    );
    expect(ackRes.status).toBe(200);
    const denyRes = await signedPost<{ approval: Approval }>(
      b,
      "/approval/claim",
      { id: declined.id, via: "deck", answer_kind: "deny" },
      op
    );
    expect(denyRes.status).toBe(200);

    const ackRow = await waitOn(b, op, acked.id);
    const denyRow = await waitOn(b, op, declined.id);
    expect([ackRow.status, ackRow.answer_kind]).toEqual(["acknowledged", null]);
    expect([denyRow.status, denyRow.answer_kind]).toEqual(["answered", "deny"]);

    const ackReply = askOperatorWaitReply(ackRow);
    const denyReply = askOperatorWaitReply(denyRow);
    expect(ackReply?.isError).toBe(false);
    expect(ackReply?.text).toContain("acknowledged");
    expect(ackReply?.text).not.toContain("rejected");
    expect(denyReply?.isError).toBe(false);
    expect(denyReply?.text).toContain("no / rejected");
    expect(denyReply?.text).not.toContain("acknowledged");

    const ackMsg = await waitForApprovalMessage(peer.frames, acked.id);
    const denyMsg = await waitForApprovalMessage(peer.frames, declined.id);
    expect(ackMsg).toContain("Acknowledged, no answer.");
    expect(ackMsg).not.toContain("Rejected");
    expect(denyMsg).toContain("Rejected.");
    expect(denyMsg).not.toContain("Acknowledged");

    const stillPending = await pendingIds(b, op);
    expect(stillPending).not.toContain(acked.id);
  }, 30_000);

  test("a keystroke-route question cannot be acknowledged and stays pending", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const approval = await raise(b, op, { tile_ref: "t-pty" });
    expect(approval.reply_route).toBe("pty");

    const res = await signedPost(b, "/approval/claim", { id: approval.id, via: "deck", acknowledge: true }, op);
    expect(res.status).toBe(422);
    expect(await pendingIds(b, op)).toContain(approval.id);
  }, 30_000);

  test("a permission approval cannot be acknowledged even on the channel route", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/ack-proj-b");
    const approval = await raise(b, op, {
      kind: "permission",
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-perm",
    });
    expect([approval.kind, approval.reply_route]).toEqual(["permission", "channel"]);

    const res = await signedPost(b, "/approval/claim", { id: approval.id, via: "deck", acknowledge: true }, op);
    expect(res.status).toBe(422);
    expect(await pendingIds(b, op)).toContain(approval.id);
  }, 30_000);

  test("a mergeable question that absorbed a permission raise for the same tile cannot be acknowledged", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/ack-proj-merge");
    const question = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-merge",
      merge: "tile",
    });
    const permission = await raise(b, op, {
      kind: "permission",
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-merge",
      merge: "tile",
    });
    expect(permission.id).not.toBe(question.id);

    const res = await signedPost(b, "/approval/claim", { id: question.id, via: "deck", acknowledge: true }, op);
    expect(res.status).toBe(422);
    expect(await pendingIds(b, op)).toContain(question.id);
  }, 30_000);

  test("acknowledge with an answer is ambiguous and refused; a second ack is already-settled", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/ack-proj-c");
    const approval = await raise(b, op, { reply_route: "channel", reply_peer_id: peer.peerId, tile_ref: "t-dup" });

    const both = await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", acknowledge: true, answer_kind: "deny" },
      op
    );
    expect(both.status).toBe(400);
    expect(await pendingIds(b, op)).toContain(approval.id);

    const first = await signedPost(b, "/approval/claim", { id: approval.id, via: "deck", acknowledge: true }, op);
    const second = await signedPost(b, "/approval/claim", { id: approval.id, via: "deck", acknowledge: true }, op);
    expect([first.status, second.status]).toEqual([200, 409]);
  }, 30_000);
});

describe("a permission raise merged into a tile's channel question", () => {
  async function pendingRow(b: TestBroker, op: Operator, id: string): Promise<Approval> {
    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      { ...approvalListBody("p"), status: "pending" },
      op
    );
    const row = list.body.approvals.find((a) => a.id === id);
    if (!row) throw new Error(`approval ${id} is not pending`);
    return row;
  }

  // Same shape as the PermissionRequest hook: no reply_route, no merge field.
  const hookPermission = {
    kind: "permission",
    title: "Bash: rm -rf build",
    question: "The agent wants to use Bash.",
    options: ["Allow", "Deny"],
    merge: undefined,
  };

  test("attention first: the permission gets its own answerable row, the question is absorbed and takes no verdict", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/merge-proj-a");

    const question = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-absorb",
      merge: "tile",
    });
    expect([question.kind, question.reply_route, question.absorbed_permission]).toEqual(["question", "channel", false]);
    const permission = await raise(b, op, { ...hookPermission, tile_ref: "t-absorb" });
    expect(permission.id, "a permission merged into the question is answerable on the tile only").not.toBe(question.id);
    expect([permission.kind, permission.reply_route]).toEqual(["permission", "pty"]);
    const again = await raise(b, op, { ...hookPermission, tile_ref: "t-absorb" });
    expect(again.id, "a double-raised permission still merges into its own row").toBe(permission.id);

    const absorbed = await pendingRow(b, op, question.id);
    expect([absorbed.kind, absorbed.reply_route, absorbed.absorbed_permission]).toEqual(["question", "channel", true]);
    expect(absorbed.mergeable, "a tile notification is mergeable").toBe(true);

    const refusals = [
      { answer_kind: "allow" },
      { answer_kind: "deny" },
      { answer_kind: "text", answer_text: "go ahead" },
      { acknowledge: true },
    ];
    for (const verdict of refusals) {
      const res = await signedPost(b, "/approval/claim", { id: question.id, via: "deck", ...verdict }, op);
      expect(res.status, `${JSON.stringify(verdict)} would settle the question while the CLI dialog stays on screen`).toBe(422);
      expect((await pendingRow(b, op, question.id)).status).toBe("pending");
    }

    const lone = await raise(b, op, { reply_route: "channel", reply_peer_id: peer.peerId, tile_ref: "t-lone" });
    expect(lone.mergeable, "a merge:'never' ticket is not mergeable").toBe(false);
    const denyLone = await signedPost(b, "/approval/claim", { id: lone.id, via: "deck", answer_kind: "deny" }, op);
    expect(denyLone.status, "a question that absorbed nothing still takes deny").toBe(200);

    const allow = await signedPost(b, "/approval/claim", { id: permission.id, via: "deck", answer_kind: "allow" }, op);
    expect(allow.status, "the permission's own row takes Allow, from the Deck or a phone").toBe(200);
  }, 30_000);

  test("a permission refused by the pending cap leaves the tile's question unabsorbed", async () => {
    const b = await startBroker({ CLAUDE_PEERS_APPROVAL_MAX_PENDING: "1" });
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/merge-proj-cap");

    const question = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-cap",
      merge: "tile",
    });
    const refused = await signedPost(
      b,
      "/approval/add",
      {
        ...hookPermission,
        tile_ref: "t-cap",
        origin: { host: "test-host", project_key: "p", group_id: "default" },
      },
      op
    );
    expect(refused.status).toBe(429);
    expect(
      (await pendingRow(b, op, question.id)).absorbed_permission,
      "an absorbed question with no permission row offers no way to answer the dialog from the inbox"
    ).toBe(false);
  }, 30_000);

  test("hook first: the attention question merges into the permission", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/merge-proj-hook-first");

    const permission = await raise(b, op, { ...hookPermission, tile_ref: "t-hook-first" });
    const question = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-hook-first",
      merge: "tile",
    });
    expect(question.id).toBe(permission.id);
    const row = await pendingRow(b, op, permission.id);
    expect([row.kind, row.reply_route, row.absorbed_permission]).toEqual(["permission", "pty", false]);
  }, 30_000);

  test("a terminal answer closes a row without relaying a verdict, and a late Approve is refused", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/merge-proj-terminal");

    const question = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-terminal",
      merge: "tile",
    });
    const permission = await raise(b, op, { ...hookPermission, tile_ref: "t-terminal" });

    const mixed = await signedPost(b, "/approval/claim", { id: question.id, via: "deck", terminal: true, acknowledge: true }, op);
    expect(mixed.status).toBe(400);
    const remote = await signedPost(b, "/approval/claim", { id: question.id, via: "ntfy", terminal: true }, op);
    expect(remote.status, "only the Deck witnesses its own terminal").toBe(400);
    const ticket = await raise(b, op, { reply_route: "channel", reply_peer_id: peer.peerId, tile_ref: "t-terminal" });
    expect(ticket.mergeable).toBe(false);
    const guarded = await signedPost(b, "/approval/claim", { id: ticket.id, via: "deck", terminal: true }, op);
    expect(guarded.status, "a guarded request gates an action: a tile's terminal answer must not settle it").toBe(422);
    expect((await pendingRow(b, op, ticket.id)).status).toBe("pending");

    for (const id of [question.id, permission.id]) {
      const closed = await signedPost<{ approval: Approval }>(b, "/approval/claim", { id, via: "deck", terminal: true }, op);
      expect(closed.status, "an absorbed question and a permission both close on a terminal answer").toBe(200);
      expect([closed.body.approval.status, closed.body.approval.answer_kind]).toEqual(["answered_terminal", null]);
      const late = await signedPost(b, "/approval/claim", { id, via: "deck", answer_kind: "allow" }, op);
      expect(late.status, "a late Approve must find the row closed").toBe(409);
    }

    const undelivered = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      { ...approvalListBody("p"), undelivered_only: true },
      op
    );
    expect(
      undelivered.body.approvals.map((a) => a.id),
      "a terminal answer listed as undelivered would be typed into the tile"
    ).not.toContain(permission.id);

    // The witness's message is pushed after the terminal claims on the same
    // socket, so once it is here a message for the question would be too.
    const witness = await raise(b, op, { reply_route: "channel", reply_peer_id: peer.peerId, tile_ref: "t-witness" });
    await signedPost(b, "/approval/claim", { id: witness.id, via: "deck", answer_kind: "deny" }, op);
    await waitForApprovalMessage(peer.frames, witness.id);
    expect(
      messageTexts(peer.frames, question.id),
      "the agent got its answer through the terminal: relaying 'Approved.' would lie about the verdict"
    ).toEqual([]);
  }, 30_000);

  test("the hook's SESSION credential marks the Deck's OPERATOR-raised question as absorbed", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/merge-proj-cross");
    const tile = "t-cross";

    const question = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: tile,
      merge: "tile",
    });

    const session = generateCredential();
    const minted = await signedPost<{ token_id: string }>(
      b,
      "/approval/token-mint",
      { session_public_key: session.publicKey, session_ref: tile },
      op
    );
    expect(minted.status).toBe(200);
    const body = {
      project_key: "p",
      kind: "permission",
      title: hookPermission.title,
      question: hookPermission.question,
      options: hookPermission.options,
      session_ref: tile,
      tile_ref: tile,
      origin: { host: "test-host", project_key: "p", group_id: "default" },
      public_key: session.publicKey,
    };
    const auth = buildAuthProof(session.privateKey, body, {
      kind: "session",
      operator_id: op.id,
      token_id: minted.body.token_id,
    });
    const permission = await post<{ approval: Approval }>(`${b.url}/approval/add`, { ...body, auth });
    expect(permission.status).toBe(200);
    expect(permission.body.approval.id, "the hook's permission keeps its own row").not.toBe(question.id);

    expect(
      (await pendingRow(b, op, question.id)).absorbed_permission,
      "a session-pinned UPDATE misses the operator-raised row, leaving deny and text open on it"
    ).toBe(true);
  }, 30_000);

  test("a text answer on a permission is refused with 422 and the row stays pending", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/merge-proj-text");

    const plain = await raise(b, op, { ...hookPermission, tile_ref: "t-plain" });
    const res = await signedPost(
      b,
      "/approval/claim",
      { id: plain.id, via: "deck", answer_kind: "text", answer_text: "Always allow" },
      op
    );
    expect(res.status, "free text would be typed into the permission chooser").toBe(422);
    expect((await pendingRow(b, op, plain.id)).status).toBe("pending");

    const lone = await raise(b, op, { reply_route: "channel", reply_peer_id: peer.peerId, tile_ref: "t-q" });
    const text = await signedPost(
      b,
      "/approval/claim",
      { id: lone.id, via: "deck", answer_kind: "text", answer_text: "go ahead" },
      op
    );
    expect(text.status, "a question still takes a text answer").toBe(200);
    const deny = await signedPost(b, "/approval/claim", { id: plain.id, via: "deck", answer_kind: "deny" }, op);
    expect(deny.status, "a permission still takes deny").toBe(200);
  }, 30_000);

  test("a question merging into an existing permission leaves the permission unchanged", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/merge-proj-b");

    const permission = await raise(b, op, { ...hookPermission, tile_ref: "t-order" });
    expect([permission.kind, permission.reply_route]).toEqual(["permission", "pty"]);
    const question = await raise(b, op, {
      title: "Fallback",
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "t-order",
      merge: "tile",
    });
    expect(question.id).toBe(permission.id);

    const row = await pendingRow(b, op, permission.id);
    expect([row.kind, row.reply_route, row.title, row.absorbed_permission]).toEqual([
      "permission",
      "pty",
      hookPermission.title,
      false,
    ]);
  }, 30_000);
});

describe("settledOutcome and its readers", () => {
  const base = { answer_text: null, answered_via: "deck" as const };

  test("each settled shape maps to its own outcome", () => {
    expect(settledOutcome({ ...base, status: "acknowledged", answer_kind: null })).toEqual({ kind: "acknowledged" });
    expect(settledOutcome({ ...base, status: "answered", answer_kind: "deny" })).toEqual({ kind: "rejected" });
    expect(settledOutcome({ ...base, status: "answered", answer_kind: "allow" })).toEqual({ kind: "approved" });
    expect(settledOutcome({ status: "answered", answer_kind: "text", answer_text: "B" })).toEqual({ kind: "text", text: "B" });
    expect(settledOutcome({ ...base, status: "abandoned", answer_kind: null })).toEqual({ kind: "gone" });
    expect(settledOutcome({ ...base, status: "expired_notif", answer_kind: null })).toEqual({ kind: "gone" });
    expect(settledOutcome({ ...base, status: "pending", answer_kind: null })).toEqual({ kind: "pending" });
  });

  test("a withdrawn question is still an error, distinct from an acknowledgement", () => {
    const gone = askOperatorWaitReply({ ...base, status: "abandoned", answer_kind: null });
    expect(gone?.isError).toBe(true);
    expect(gone?.text).toContain("withdrawn");
    expect(askOperatorWaitReply({ ...base, status: "pending", answer_kind: null })).toBeNull();
  });

  test("the phone copy of an acknowledged approval never reads as rejected", () => {
    const approval = {
      title: "Finding",
      status: "acknowledged",
      answer_kind: null,
      answer_text: null,
    } as unknown as Approval;
    const text = renderSettled(approval, "deck");
    expect(text).toContain("acknowledged");
    expect(text).not.toContain("rejected");
  });

  test("a terminal answer reads as answered in the terminal, never as a verdict or a withdrawal", () => {
    const terminal = { ...base, status: "answered_terminal" as const, answer_kind: null };
    expect(settledOutcome(terminal)).toEqual({ kind: "terminal" });
    const reply = askOperatorWaitReply(terminal);
    expect(reply?.isError, "the operator did answer: this is not a withdrawn question").toBe(false);
    expect(reply?.text).toContain("terminal");
    const phone = renderSettled({ title: "Bash", ...terminal } as unknown as Approval, "deck");
    expect(phone).toContain("answered in the terminal");
    expect(phone).not.toMatch(/approved|rejected|closed/);
  });
});
