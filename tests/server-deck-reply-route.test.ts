import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  livePid,
  scrubEnv,
  type RunCredential,
  type TestBroker,
} from "./_helper.ts";
import {
  buildAuthProof,
  deriveInstanceRef,
  deriveTokenId,
  generateCredential,
} from "../shared/approval.ts";
import { writeSessionIdentityFile } from "../shared/peer-cache.ts";
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
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
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

async function readBeforeWait(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  id: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  return Promise.race([
    readUntil(reader, id, buffer),
    Bun.sleep(1_000).then(() => {
      throw new Error("ask_operator did not report the channel fallback before waiting");
    }),
  ]);
}

/** Register a plain peer (no WS needed: status='active' is set unconditionally at insert). */
async function registerTestPeer(
  b: TestBroker,
  groupId: string
): Promise<{ peerId: string; instanceToken: string }> {
  const reg = await post<{ peer_id: string; instance_token: string }>(`${b.url}/register`, {
    pid: livePid(),
    cwd: "/tmp/deck-reply-route-test",
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    client_pid: 1,
    project_key: null,
    group_id: groupId,
    group_secret_hash: null,
  });
  expect(reg.status).toBe(200);
  return { peerId: reg.body.peer_id, instanceToken: reg.body.instance_token };
}

/** Boot a real server-deck.ts process against a real broker, with an
 * approval session credential armed and an optional per-tile identity file. */
/** Pumps a process's stderr into a growing string, for tests that assert on
 * a log line rather than on wire behaviour (MAJOR 3: the identity-absent
 * degradation must be traced, not silent). */
function pumpStderr(proc: ReturnType<typeof Bun.spawn>): { text: string } {
  const buffer = { text: "" };
  (async () => {
    const decoder = new TextDecoder();
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buffer.text += decoder.decode(value, { stream: true });
    }
  })();
  return buffer;
}

async function attestedTile(b: TestBroker, label: string): Promise<{ run: RunCredential; peerId: string; groupId: string; instanceToken: string }> {
  const run = await mintRunCredential(b, { id: await groupId(label), hash: await sha256Hex(label) }, SPAWNED_SERVER_PROJECT_KEY);
  const reg = await registerAttestedInstance(b, run, "test-host", `/tmp/${label}`);
  expect(reg.status).toBe(200);
  return { run, peerId: reg.body.peer_id, groupId: run.group, instanceToken: reg.body.instance_token };
}

async function bootDeck(
  b: TestBroker,
  opts: {
    deskSession: string;
    identity: { peerId: string; groupId: string; instanceToken: string } | null;
    run?: RunCredential;
    confirmation?: { runRef: string; groupId: string; operatorId: string } | null;
  }
): Promise<{
  proc: ReturnType<typeof Bun.spawn>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  stderr: { text: string };
  send: (msg: unknown) => void;
  opCred: { privateKey: string; publicKey: string; id: string };
}> {
  const homeDir = mkdtempSync(join(tmpdir(), "cp-deck-home-"));
  dirs.push(homeDir);
  const credDir = mkdtempSync(join(tmpdir(), "cp-deck-cred-"));
  dirs.push(credDir);

  if (opts.identity) {
    await writeSessionIdentityFile(
      opts.deskSession,
      opts.identity.peerId,
      opts.identity.groupId,
      opts.identity.instanceToken,
      homeDir,
      opts.confirmation === null
        ? null
        : opts.confirmation
          ? { version: 1, runRef: opts.confirmation.runRef, groupId: opts.confirmation.groupId }
          : opts.run
            ? { version: 1, runRef: opts.run.run, groupId: opts.run.group }
            : null,
      opts.confirmation === null ? null : opts.confirmation?.operatorId ?? (opts.run ? FIXTURE_OPERATOR_ID : null),
    );
  }

  const opCred = FIXTURE_OPERATOR;
  const operatorId = FIXTURE_OPERATOR_ID;
  const credFile = join(credDir, "approval.json");
  if (opts.run) {
    await Bun.write(
      credFile,
      JSON.stringify({
        brokerUrl: b.url,
        operatorId,
        tokenId: opts.run.tokenId,
        sessionRef: `window-${opts.run.run}`,
        privateKey: opts.run.cred.privateKey,
        publicKey: opts.run.cred.publicKey,
        osUserHash: "hash-of-olivier",
        inbox: { version: 1, run_ref: opts.run.run, group_id: opts.run.group },
      })
    );
  } else {
    const sessionCred = generateCredential();
    const mintBody = {
      session_public_key: sessionCred.publicKey,
      session_ref: "deck-tile-1",
      project_key: SPAWNED_SERVER_PROJECT_KEY,
      public_key: opCred.publicKey,
    };
    const auth = buildAuthProof(opCred.privateKey, mintBody, { kind: "operator", operator_id: operatorId });
    expect((await post(`${b.url}/approval/token-mint`, { ...mintBody, auth })).status).toBe(200);
    await Bun.write(
      credFile,
      JSON.stringify({
        brokerUrl: b.url,
        operatorId,
        tokenId: deriveTokenId(sessionCred.publicKey),
        sessionRef: "deck-tile-1",
        privateKey: sessionCred.privateKey,
        publicKey: sessionCred.publicKey,
        osUserHash: "hash-of-olivier",
      })
    );
  }

  const proc = Bun.spawn(["bun", "server-deck.ts"], {
    env: scrubEnv(homeDir, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_APPROVAL_FILE: credFile,
      CLAUDE_PEERS_DESK_SESSION: opts.deskSession,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const stderr = pumpStderr(proc);
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

  return { proc, reader, buffer, stderr, send, opCred: { ...opCred, id: operatorId } };
}

async function firstApproval(
  b: TestBroker,
  opCred: { privateKey: string; publicKey: string; id: string },
  runRef?: string
): Promise<{ id: string; reply_route: string; author_instance_hint?: string } | null> {
  for (let i = 0; i < 80; i++) {
    const body = { project_key: SPAWNED_SERVER_PROJECT_KEY, public_key: opCred.publicKey, ...(runRef ? { run_ref: runRef } : {}) };
    const auth = buildAuthProof(opCred.privateKey, body, { kind: "operator", operator_id: opCred.id });
    const res = await post<{ approvals: Array<{ id: string; reply_route: string; author_instance_hint?: string }> }>(
      `${b.url}/approval/list`,
      { ...body, auth }
    );
    const found = res.body.approvals?.[0];
    if (found) return found;
    await Bun.sleep(100);
  }
  return null;
}

describe("server-deck.ts ask_operator reply routing", () => {
  test("a matching identity file resolves to an attested channel question for that instance", async () => {
    const b = await startBroker();
    brokers.push(b);
    const tile = await attestedTile(b, "deck-reply-route-group-positive");

    const h = await bootDeck(b, { deskSession: "probe-positive", identity: tile, run: tile.run });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });

    const approval = await firstApproval(b, h.opCred, tile.run.run);
    expect(approval).not.toBeNull();
    expect(approval?.reply_route).toBe("channel");
    expect(approval?.author_instance_hint).toBe(deriveInstanceRef(tile.instanceToken).slice(-12));
  }, 30_000);

  test("only the confirmed operator, run and group can create a channel question", async () => {
    const b = await startBroker();
    brokers.push(b);
    const tile = await attestedTile(b, "deck-reply-route-readiness");
    const cases = [
      ["operator", { runRef: tile.run.run, groupId: tile.run.group, operatorId: "other-operator" }],
      ["run", { runRef: "other-run", groupId: tile.run.group, operatorId: FIXTURE_OPERATOR_ID }],
      ["group", { runRef: tile.run.run, groupId: "other-group", operatorId: FIXTURE_OPERATOR_ID }],
    ] as const;

    for (const [label, confirmation] of cases) {
      const h = await bootDeck(b, {
        deskSession: `probe-readiness-${label}`,
        identity: tile,
        run: tile.run,
        confirmation,
      });
      h.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
      });
      const res = await readUntil(h.reader, 1, h.buffer);
      expect(res.result?.isError, label).toBe(true);
      expect(await approvalListedOnce(b, h.opCred, tile.run.run), label).toBeNull();
    }
  }, 30_000);

  test("a project CWD distinct from the run project still creates a channel question", async () => {
    const b = await startBroker();
    brokers.push(b);
    const tile = await attestedTile(b, "deck-reply-route-project-cwd");
    const h = await bootDeck(b, { deskSession: "probe-project-cwd", identity: tile, run: tile.run });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });

    const approval = await firstApproval(b, h.opCred, tile.run.run);
    expect(approval?.reply_route).toBe("channel");
  }, 30_000);

  test("without a run credential a channel question is refused, never silently turned into a pty one", async () => {
    const b = await startBroker();
    brokers.push(b);
    const groupId = "deck-reply-route-group-legacy";
    const { peerId, instanceToken } = await registerTestPeer(b, groupId);

    const h = await bootDeck(b, { deskSession: "probe-legacy", identity: { peerId, groupId, instanceToken } });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? "").toContain("run credential has no Inbox scope");
  }, 30_000);

  test("an absent identity file refuses a new question without creating a deposit", async () => {
    const b = await startBroker();
    brokers.push(b);
    const run = await mintRunCredential(b, { id: await groupId("deck-reply-route-missing"), hash: await sha256Hex("deck-reply-route-missing") }, SPAWNED_SERVER_PROJECT_KEY);

    const h = await bootDeck(b, { deskSession: "probe-negative", identity: null, run });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });

    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? "").toContain("Inbox registration is not yet confirmed");
    expect(await firstApproval(b, h.opCred, run.run)).toBeNull();
  }, 30_000);

  test("MAJOR 3: a desk_session token with no usable identity file is traced, not silent", async () => {
    const b = await startBroker();
    brokers.push(b);

    const h = await bootDeck(b, { deskSession: "probe-traced", identity: null });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });
    await firstApproval(b, h.opCred);

    expect(h.stderr.text).toContain("No usable session-identity file for desk_session 'probe-traced'");
  }, 30_000);

  test("an entirely absent desk_session token logs its own distinct trace naming the tools that will refuse", async () => {
    const b = await startBroker();
    brokers.push(b);

    const h = await bootDeck(b, { deskSession: "", identity: null });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });
    await firstApproval(b, h.opCred);

    expect(h.stderr.text).toContain("CLAUDE_PEERS_DESK_SESSION is unset");
    expect(h.stderr.text).toContain("graph_draft_send");
    expect(h.stderr.text).toContain("roadmap_dispatch");
    // Distinct trace from the "token present but file missing" case above --
    // an empty token must never fire that other branch's message.
    expect(h.stderr.text).not.toContain("No usable session-identity file");
    // instanceToken is a credential: never named in any trace, in either branch.
    expect(h.stderr.text).not.toContain("instanceToken");
  }, 30_000);

  test("a stale identity is refused before waiting, never routed to a peer that left", async () => {
    const b = await startBroker();
    brokers.push(b);
    const tile = await attestedTile(b, "deck-reply-route-group-stale");
    expect((await post(`${b.url}/disconnect`, { instance_token: tile.instanceToken })).status).toBe(200);

    const h = await bootDeck(b, { deskSession: "probe-stale", identity: tile, run: tile.run });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });

    const res = await readBeforeWait(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text ?? "").toContain("not registered in this run's group");
    expect(await approvalListedOnce(b, h.opCred, tile.run.run), "nothing was raised").toBeNull();
    for (let i = 0; i < 50 && !h.stderr.text.includes("ask_operator failed"); i++) await Bun.sleep(20);
    expect(h.stderr.text, "the failed signed question is logged").toContain("ask_operator failed");
  }, 30_000);
});

async function approvalListedOnce(
  b: TestBroker,
  opCred: { privateKey: string; publicKey: string; id: string },
  runRef: string
): Promise<{ id: string } | null> {
  const body = { project_key: SPAWNED_SERVER_PROJECT_KEY, public_key: opCred.publicKey, run_ref: runRef };
  const auth = buildAuthProof(opCred.privateKey, body, { kind: "operator", operator_id: opCred.id });
  const res = await post<{ approvals: Array<{ id: string }> }>(`${b.url}/approval/list`, { ...body, auth });
  return res.body.approvals?.[0] ?? null;
}
