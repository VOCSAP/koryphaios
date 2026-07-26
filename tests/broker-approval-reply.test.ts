// The 'channel' return path (PLAN C-9 / lot N2.e): when the agent is at its
// prompt, the broker hands the answer over as a claude-peers message instead of
// leaving the Deck to type it. Proven against a REAL registered peer holding a
// real WebSocket.

import { test, expect, describe, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";
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

function newOperator(): { cred: ApprovalCredential; id: string } {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
}

async function signedPost<T>(
  b: TestBroker,
  path: string,
  payload: Record<string, unknown>,
  op: { cred: ApprovalCredential; id: string }
): Promise<{ status: number; body: T }> {
  const body = { ...payload, public_key: op.cred.publicKey };
  const auth = buildAuthProof(op.cred.privateKey, body, {
    kind: "operator",
    operator_id: op.id,
  });
  return post<T>(`${b.url}${path}`, { ...body, auth });
}

/** Register a peer and open its authenticated WebSocket. */
async function connectPeer(
  b: TestBroker,
  cwd: string
): Promise<{ peerId: string; token: string; frames: unknown[]; ws: WebSocket }> {
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
  // Let the auth frame land before anything is pushed.
  await Bun.sleep(200);
  return { peerId: reg.body.peer_id, token: reg.body.instance_token, frames, ws };
}

async function waitForMessage(frames: unknown[], match: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 60; i++) {
    const hit = frames.find(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { type?: string }).type === "message" &&
        String((f as { text?: string }).text ?? "").includes(match)
    );
    if (hit) return hit as Record<string, unknown>;
    await Bun.sleep(100);
  }
  throw new Error(`no message containing "${match}" (got ${JSON.stringify(frames)})`);
}

async function raise(
  b: TestBroker,
  op: { cred: ApprovalCredential; id: string },
  extra: Record<string, unknown>
): Promise<Approval> {
  const res = await signedPost<{ approval: Approval }>(
    b,
    "/approval/add",
    {
      kind: "question",
      title: "Which strategy?",
      question: "A or B?",
      origin: { host: "test-host", project_key: "p", group_id: "default" },
      ...extra,
    },
    op
  );
  expect(res.status).toBe(200);
  return res.body.approval;
}

describe("channel return path", () => {
  test("the answer reaches the peer as a message from the operator sentinel", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/proj-a");

    const approval = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "tile-1",
    });
    expect(approval.reply_route).toBe("channel");

    await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "telegram", answer_kind: "text", answer_text: "go with B" },
      op
    );

    const frame = await waitForMessage(peer.frames, "go with B");
    expect(frame.from_peer_id).toBe("operator");
    // The approval id travels so the agent can correlate it with its question.
    expect(String(frame.text)).toContain(approval.id);
  }, 30_000);

  test("allow and deny are rendered as words, not as raw verdicts", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/proj-b");

    const approval = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "tile-2",
    });
    await signedPost(b, "/approval/claim", { id: approval.id, via: "deck", answer_kind: "allow" }, op);
    const frame = await waitForMessage(peer.frames, "Approved");
    expect(frame.from_peer_id).toBe("operator");
  }, 30_000);

  test("the routing token never crosses the HTTP boundary", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/proj-c");

    const approval = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: peer.peerId,
      tile_ref: "tile-3",
    });
    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", {}, op);
    const wire = JSON.stringify({ approval, list: list.body });
    expect(wire).not.toContain(peer.token);
    expect(wire).not.toContain("reply_token");
    // The ROUTE itself is public — the Deck needs it to know not to type.
    expect(approval.reply_route).toBe("channel");
  }, 30_000);

  test("an unknown or dormant peer downgrades to pty instead of silently failing", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();

    const approval = await raise(b, op, {
      reply_route: "channel",
      reply_peer_id: "nobody-here",
      tile_ref: "tile-4",
    });
    // Better a keystroke fallback than a route that can never deliver.
    expect(approval.reply_route).toBe("pty");
  }, 30_000);

  test("a pty approval pushes nothing to the peer", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const peer = await connectPeer(b, "/tmp/proj-d");

    const approval = await raise(b, op, { tile_ref: "tile-5" });
    expect(approval.reply_route).toBe("pty");
    await signedPost(
      b,
      "/approval/claim",
      { id: approval.id, via: "deck", answer_kind: "text", answer_text: "typed instead" },
      op
    );
    await Bun.sleep(500);
    const pushed = peer.frames.filter(
      (f) => typeof f === "object" && f !== null && (f as { type?: string }).type === "message"
    );
    expect(pushed).toHaveLength(0);
  }, 30_000);
});

describe("de-duplication", () => {
  test("a second raise for the same waiting tile reuses the first approval", async () => {
    // The hook's idle_prompt and the Deck's attention detector both fire on the
    // same screen; the operator's phone must ring once, not twice.
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();

    const first = await raise(b, op, { tile_ref: "tile-dup" });
    const second = await raise(b, op, { tile_ref: "tile-dup", title: "Something else" });
    expect(second.id).toBe(first.id);

    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", {}, op);
    expect(list.body.approvals).toHaveLength(1);
  }, 30_000);

  test("different tiles keep their own approvals", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const a = await raise(b, op, { tile_ref: "tile-x" });
    const c = await raise(b, op, { tile_ref: "tile-y" });
    expect(c.id).not.toBe(a.id);
  }, 30_000);

  test("once settled, the same tile can raise again", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
    const first = await raise(b, op, { tile_ref: "tile-z" });
    await signedPost(b, "/approval/claim", { id: first.id, via: "deck", answer_kind: "allow" }, op);
    const second = await raise(b, op, { tile_ref: "tile-z" });
    expect(second.id).not.toBe(first.id);
  }, 30_000);
});
