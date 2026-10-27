import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_OPERATOR,
  FIXTURE_OPERATOR_ID,
  groupId,
  mintRunCredential,
  registerAttestedInstance,
  sha256Hex,
  startBroker,
  stopBroker,
  post,
  approvalListBody,
  scrubEnv,
  type RunCredential,
  type TestBroker,
} from "./_helper.ts";
import { APPROVAL_OPTIONS_MAX, buildAuthProof } from "../shared/approval.ts";
import { writeSessionIdentityFile } from "../shared/peer-cache.ts";
import type { Approval } from "../shared/types.ts";
import { resolveProjectKey } from "../shared/project-key.ts";
import { computeProjectKey } from "../shared/summarize.ts";

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      env: scrubEnv(tmpdir()),
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
  result?: {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, { maxItems?: number }> } }>;
  };
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
  run: RunCredential | null;
  send: (msg: unknown) => void;
}

const DESK_SESSION = "ask-operator-test";

async function boot(withCredential: boolean): Promise<Harness> {
  const b = await startBroker();
  brokers.push(b);
  const dir = mkdtempSync(join(tmpdir(), "cp-ask-"));
  dirs.push(dir);

  const extra: Record<string, string> = {
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    CLAUDE_PEERS_DESK_SESSION: DESK_SESSION,
  };
  let run: RunCredential | null = null;
  if (withCredential) {
    // A new question is deposited only by a run credential carrying an Inbox
    // block, from a tile whose registration the broker attested for that same
    // run and group; project_key must be the one firstApproval lists by.
    const label = `ask-operator-${crypto.randomUUID()}`;
    run = await mintRunCredential(b, { id: await groupId(label), hash: await sha256Hex(label) }, SPAWNED_SERVER_PROJECT_KEY);
    const reg = await registerAttestedInstance(b, run, "test-host", `/tmp/${label}`);
    expect(reg.status).toBe(200);
    await writeSessionIdentityFile(
      DESK_SESSION,
      reg.body.peer_id,
      run.group,
      reg.body.instance_token,
      dir,
      { version: 1, runRef: run.run, groupId: run.group },
      FIXTURE_OPERATOR_ID,
    );
    const credFile = join(dir, "approval.json");
    writeFileSync(
      credFile,
      JSON.stringify({
        brokerUrl: b.url,
        operatorId: FIXTURE_OPERATOR_ID,
        tokenId: run.tokenId,
        sessionRef: `window-${run.run}`,
        privateKey: run.cred.privateKey,
        publicKey: run.cred.publicKey,
        osUserHash: "hash-of-olivier",
        inbox: { version: 1, run_ref: run.run, group_id: run.group },
      }),
      { mode: 0o600 }
    );
    extra.CLAUDE_PEERS_APPROVAL_FILE = credFile;
  }
  const proc = Bun.spawn(["bun", "server-deck.ts"], {
    env: scrubEnv(dir, extra),
    stdio: ["pipe", "pipe", "pipe"],
  });
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

  return { b, proc, reader, buffer, op: { ...FIXTURE_OPERATOR, id: FIXTURE_OPERATOR_ID }, run, send };
}

async function firstApproval(h: Harness): Promise<Approval | null> {
  for (let i = 0; i < 80; i++) {
    const body = approvalListBody(SPAWNED_SERVER_PROJECT_KEY, { public_key: h.op.publicKey, run_ref: h.run!.run });
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
    const ask = res.result?.tools?.find((t) => t.name === "ask_operator");
    expect(ask?.inputSchema?.properties?.options?.maxItems).toBe(APPROVAL_OPTIONS_MAX);
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
    expect(approval?.origin.session_ref).toBe(`window-${h.run!.run}`);

    expect(await claim(h, approval!.id, "text", "go with B, but keep a backup")).toBe(200);

    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.content?.[0]?.text).toContain("go with B, but keep a backup");
    expect(res.result?.content?.[0]?.text).toContain("telegram");
  }, 60_000);

  test("a deny verdict is rendered as a rejection, not raw JSON", async () => {
    const h = await boot(true);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "Deploy", question: "Ship it?" } },
    });
    const approval = await firstApproval(h);
    expect(await claim(h, approval!.id, "deny")).toBe(200);
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.content?.[0]?.text).toContain("rejected");
  }, 60_000);

  test("an over-long question reaches the broker whole and is stored with the truncation marker", async () => {
    const h = await boot(true);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "Long", question: "q".repeat(5000) } },
    });
    const approval = await firstApproval(h);
    expect(approval?.question.endsWith("[truncated from 5000 characters]"), approval?.question.slice(-60)).toBe(true);
  }, 60_000);

  test("an eleventh option is refused with the broker's limit instead of being cut, ten are accepted", async () => {
    const h = await boot(true);
    const ask = (id: number, count: number) =>
      h.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "ask_operator",
          arguments: {
            title: "Pick",
            question: "Which one?",
            options: Array.from({ length: count }, (_, i) => `option ${i + 1}`),
          },
        },
      });
    const settled = <T>(p: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ask_operator neither refused nor answered within 15 s")), 15_000);
      });
      return Promise.race([p, limit]).finally(() => clearTimeout(timer));
    };

    ask(1, APPROVAL_OPTIONS_MAX + 1);
    const refused = await settled(readUntil(h.reader, 1, h.buffer));
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain(`at most ${APPROVAL_OPTIONS_MAX} options`);

    ask(2, APPROVAL_OPTIONS_MAX);
    const approval = await firstApproval(h);
    expect(approval?.options).toEqual(Array.from({ length: APPROVAL_OPTIONS_MAX }, (_, i) => `option ${i + 1}`));
    expect(await claim(h, approval!.id, "deny")).toBe(200);
    const accepted = await settled(readUntil(h.reader, 2, h.buffer));
    expect(accepted.result?.isError).toBeFalsy();
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
