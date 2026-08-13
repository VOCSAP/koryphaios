// ask_operator over a real MCP stdio session against a real broker
// (PLAN-notifications-mobiles N2.b). Extends the harness of
// server-stdin-eof.test.ts: spawn `bun server.ts`, speak JSON-RPC on stdin.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  deriveTokenId,
  generateCredential,
} from "../shared/approval.ts";
import type { Approval } from "../shared/types.ts";

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const b of brokers) await stopBroker(b);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ text?: string }>; isError?: boolean; tools?: Array<{ name: string }> };
}

/** Read stdout until a JSON-RPC message with the wanted id shows up. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let idx: number;
    while ((idx = buffer.text.indexOf("\n")) >= 0) {
      const line = buffer.text.slice(0, idx).trim();
      buffer.text = buffer.text.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id === wantedId) return msg;
      } catch {
        /* not a complete JSON line yet */
      }
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer.text += decoder.decode(value, { stream: true });
  }
  throw new Error(`no JSON-RPC response with id ${wantedId}`);
}

interface Harness {
  b: TestBroker;
  proc: ReturnType<typeof Bun.spawn>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  op: { privateKey: string; publicKey: string; id: string };
  send: (msg: unknown) => void;
}

async function boot(withCredential: boolean): Promise<Harness> {
  const b = await startBroker();
  brokers.push(b);
  const dir = mkdtempSync(join(tmpdir(), "cp-ask-"));
  dirs.push(dir);

  const opCred = generateCredential();
  const operatorId = deriveOperatorId(opCred.publicKey);
  const sessionCred = generateCredential();

  const mintBody = {
    session_public_key: sessionCred.publicKey,
    session_ref: "tile-1",
    public_key: opCred.publicKey,
  };
  const auth = buildAuthProof(opCred.privateKey, mintBody, {
    kind: "operator",
    operator_id: operatorId,
  });
  expect((await post(`${b.url}/approval/token-mint`, { ...mintBody, auth })).status).toBe(200);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
  };
  if (withCredential) {
    const credFile = join(dir, "approval.json");
    writeFileSync(
      credFile,
      JSON.stringify({
        brokerUrl: b.url,
        operatorId,
        tokenId: deriveTokenId(sessionCred.publicKey),
        sessionRef: "tile-1",
        privateKey: sessionCred.privateKey,
        publicKey: sessionCred.publicKey,
        osUserHash: "hash-of-olivier",
      }),
      { mode: 0o600 }
    );
    env.CLAUDE_PEERS_APPROVAL_FILE = credFile;
  } else {
    delete env.CLAUDE_PEERS_APPROVAL_FILE;
  }

  const proc = Bun.spawn(["bun", "server.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };

  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "test-harness", version: "0.0.1" },
    },
  });
  await readUntil(reader, 0, buffer);

  return { b, proc, reader, buffer, op: { ...opCred, id: operatorId }, send };
}

async function firstApproval(h: Harness): Promise<Approval | null> {
  for (let i = 0; i < 80; i++) {
    const body = { public_key: h.op.publicKey };
    const auth = buildAuthProof(h.op.privateKey, body, {
      kind: "operator",
      operator_id: h.op.id,
    });
    const res = await post<{ approvals: Approval[] }>(`${h.b.url}/approval/list`, { ...body, auth });
    const found = res.body.approvals?.[0];
    if (found) return found;
    await Bun.sleep(100);
  }
  return null;
}

async function claim(
  h: Harness,
  id: string,
  answer_kind: string,
  answer_text?: string
): Promise<number> {
  const body: Record<string, unknown> = {
    id,
    via: "telegram",
    answer_kind,
    public_key: h.op.publicKey,
  };
  if (answer_text) body.answer_text = answer_text;
  const auth = buildAuthProof(h.op.privateKey, body, { kind: "operator", operator_id: h.op.id });
  return (await post(`${h.b.url}/approval/claim`, { ...body, auth })).status;
}

describe("ask_operator over MCP stdio", () => {
  test("the tools are advertised", async () => {
    const h = await boot(true);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("ask_operator");
    expect(names).toContain("ask_operator_wait");
  }, 60_000);

  test("without a credential the tool refuses instead of hanging, naming the real cause", async () => {
    const h = await boot(false);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? "";
    // Card 469f3176 review: this refusal used to be worded "not enabled",
    // which became FALSE once arming stopped being gated on mobileApprovals
    // -- the only way left to hit this path is a session that predates the
    // arming. Anchored on the two facts that carry the meaning (the cause
    // named, the remediation given) rather than a loose fragment that would
    // pass with any refusal text: this must still catch a regression back to
    // the stale wording, or to a message that stops naming either one.
    expect(text).toContain("before remote approvals were armed");
    expect(text).toContain("Restart the session");
  }, 60_000);

  test("the operator's free text comes back as the tool result", async () => {
    const h = await boot(true);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_operator",
        arguments: { title: "Migration", question: "Which strategy?", options: ["A", "B"] },
      },
    });

    const approval = await firstApproval(h);
    expect(approval).not.toBeNull();
    expect(approval?.kind).toBe("question");
    expect(approval?.title).toBe("Migration");
    expect(approval?.options).toEqual(["A", "B"]);
    // The MCP tool signs with the RESTRICTED session credential.
    expect(approval?.origin.session_ref).toBe("tile-1");

    expect(await claim(h, approval!.id, "text", "go with B, but keep a backup")).toBe(200);

    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.content?.[0]?.text).toContain("go with B, but keep a backup");
    expect(res.result?.content?.[0]?.text).toContain("telegram");
  }, 60_000);

  test("an allow verdict is rendered as an approval, not raw JSON", async () => {
    const h = await boot(true);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "Deploy", question: "Ship it?" } },
    });
    const approval = await firstApproval(h);
    expect(await claim(h, approval!.id, "allow")).toBe(200);
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.content?.[0]?.text).toContain("approved");
  }, 60_000);

  test("ask_operator_wait on an unknown ticket errors rather than blocking", async () => {
    const h = await boot(true);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator_wait", arguments: { ticket: "does-not-exist" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
  }, 60_000);
});
