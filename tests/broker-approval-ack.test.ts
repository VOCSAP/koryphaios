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
    expect(permission.id).toBe(question.id);

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
});
