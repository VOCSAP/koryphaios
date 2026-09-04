// Card c9269fef lot L2-bis: server-deck.ts resolves its own reply routing
// identity from the per-tile session-identity file, read lazily on every
// ask_operator call rather than cached at boot.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
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

async function bootDeck(
  b: TestBroker,
  opts: { deskSession: string; identity: { peerId: string; groupId: string } | null }
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
    await writeSessionIdentityFile(opts.deskSession, opts.identity.peerId, opts.identity.groupId, homeDir);
  }

  const opCred = generateCredential();
  const operatorId = deriveOperatorId(opCred.publicKey);
  const sessionCred = generateCredential();
  const mintBody = {
    session_public_key: sessionCred.publicKey,
    session_ref: "deck-tile-1",
    project_key: SPAWNED_SERVER_PROJECT_KEY,
    public_key: opCred.publicKey,
  };
  const auth = buildAuthProof(opCred.privateKey, mintBody, { kind: "operator", operator_id: operatorId });
  expect((await post(`${b.url}/approval/token-mint`, { ...mintBody, auth })).status).toBe(200);

  const credFile = join(credDir, "approval.json");
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

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    CLAUDE_PEERS_APPROVAL_FILE: credFile,
    CLAUDE_PEERS_DESK_SESSION: opts.deskSession,
    // Points readSessionIdentityFile's default homedir() at our isolated
    // fixture instead of the real one -- confirmed to control os.homedir()
    // on this platform (USERPROFILE wins over HOME on win32).
    USERPROFILE: homeDir,
    HOME: homeDir,
  };

  const proc = Bun.spawn(["bun", "server-deck.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
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
  opCred: { privateKey: string; publicKey: string; id: string }
): Promise<{ id: string; reply_route: string } | null> {
  for (let i = 0; i < 80; i++) {
    const body = { project_key: SPAWNED_SERVER_PROJECT_KEY, public_key: opCred.publicKey };
    const auth = buildAuthProof(opCred.privateKey, body, { kind: "operator", operator_id: opCred.id });
    const res = await post<{ approvals: Array<{ id: string; reply_route: string }> }>(
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
  test("PREDICTION: a matching identity file resolves to reply_route channel", async () => {
    const b = await startBroker();
    brokers.push(b);
    const groupId = "deck-reply-route-group-positive";
    const { peerId } = await registerTestPeer(b, groupId);

    const h = await bootDeck(b, { deskSession: "probe-positive", identity: { peerId, groupId } });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });

    const approval = await firstApproval(b, h.opCred);
    expect(approval).not.toBeNull();
    expect(approval?.reply_route).toBe("channel");
  }, 30_000);

  test("NEGATIVE CONTROL: an absent identity file resolves to reply_route pty, explicitly", async () => {
    const b = await startBroker();
    brokers.push(b);

    const h = await bootDeck(b, { deskSession: "probe-negative", identity: null });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });

    const approval = await firstApproval(b, h.opCred);
    expect(approval).not.toBeNull();
    expect(approval?.reply_route).toBe("pty");
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

  test("MEASURE: a stale identity file pointing at a dormant peer still resolves to pty (no file deletion needed on cleanup for this lot)", async () => {
    const b = await startBroker();
    brokers.push(b);
    const groupId = "deck-reply-route-group-stale";
    const { peerId, instanceToken } = await registerTestPeer(b, groupId);
    expect((await post(`${b.url}/disconnect`, { instance_token: instanceToken })).status).toBe(200);

    const h = await bootDeck(b, { deskSession: "probe-stale", identity: { peerId, groupId } });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_operator", arguments: { title: "t", question: "q" } },
    });

    const approval = await firstApproval(b, h.opCred);
    expect(approval).not.toBeNull();
    expect(approval?.reply_route).toBe("pty");
  }, 30_000);
});
