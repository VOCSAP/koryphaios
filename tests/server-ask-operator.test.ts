// ask_operator over a real MCP stdio session against a real broker
// (PLAN-notifications-mobiles N2.b). Extends the harness of
// server-stdin-eof.test.ts: spawn `bun server.ts`, speak JSON-RPC on stdin.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, approvalListBody, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  deriveTokenId,
  generateCredential,
} from "../shared/approval.ts";
import type { Approval } from "../shared/types.ts";
import { resolveProjectKey } from "../shared/project-key.ts";
import { computeProjectKey } from "../shared/summarize.ts";

// Card 4df14b5b: /approval/list now requires project_key. boot() spawns
// `bun server.ts` with no explicit `cwd` (Bun.spawn inherits this test
// runner's cwd), so the spawned process raises its ask_operator approval
// with origin.project_key: roadmapProjectKey() resolved from that SAME cwd
// -- server.ts:920's private roadmapProjectKey() combines resolveProjectKey
// (shared/project-key.ts) with computeProjectKey (shared/summarize.ts) and a
// git-root lookup. server.ts has zero exports and runs main() unconditionally
// at module scope, so it cannot be imported here; this mirrors its inputs
// instead of guessing a literal. A wrong-but-non-empty literal would be
// WORSE than an empty one: the broker returns 200 with a silently empty
// list, indistinguishable from "not raised yet" (measured against this
// repo's real remote: normalizeRemoteUrl lowercases the host but not the
// path, so the derived key here is "github.com/VOCSAP/koryphaios" --
// capital VOCSAP, not the lowercase fixture literal used elsewhere in
// tests/broker-approvals.test.ts, which is a synthetic value never derived
// from a real remote). Computed once at module scope, since it shells out to
// git and cannot change within this test run.

/** Mirrors server.ts's private, unexported getGitRoot() -- same command,
 * same shape, kept local since server.ts cannot be imported (see above). */
async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

const SPAWNED_SERVER_PROJECT_KEY = await (async () => {
  const cwd = process.cwd();
  const [remote, root] = await Promise.all([computeProjectKey(cwd), getGitRoot(cwd)]);
  return resolveProjectKey(remote, root, cwd);
})();

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
    // Card 1def56da: the Deck PINS the window's project into the credential at
    // mint time, so the agent holding it cannot choose the project its blocking
    // questions are filed under. Required, and it must sit in the object BEFORE
    // buildAuthProof below -- the proof covers the body minus its own `auth`,
    // so a field appended afterwards yields 401 rather than the 200 asserted.
    //
    // THE VALUE MATTERS, and it is the same constant `firstApproval` lists by.
    // The card creates an AGREEMENT the code did not need before: an approval
    // raised by this session is now filed under the TOKEN's project, so a
    // window that minted with one value and lists with another sees nothing at
    // all. Hardcoding a different literal here made three tests fail with an
    // empty list and no error, which is precisely the shape that agreement can
    // fail in. In production both ends come from `safeProjectKey()`
    // (approval-runtime.ts), so they agree by construction.
    project_key: SPAWNED_SERVER_PROJECT_KEY,
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
    const body = approvalListBody(SPAWNED_SERVER_PROJECT_KEY, { public_key: h.op.publicKey });
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
    // Card 1def56da: an OPERATOR credential declares the project it acts on, on
    // /approval/claim as on the other three routes. Same value the approval was
    // filed under, or the claim resolves nothing and returns 404.
    project_key: SPAWNED_SERVER_PROJECT_KEY,
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
