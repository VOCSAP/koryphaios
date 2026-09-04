// Card c9269fef lot L3: graph_draft_send and roadmap_dispatch require a
// PROVEN peer identity (instance_token), resolved by server-deck.ts from the
// per-tile session-identity file at call time, never by self-registering.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import { writeSessionIdentityFile } from "../shared/peer-cache.ts";

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

/** Register a plain peer WITH a project_key: /graph-draft/add and
 * /dispatch-request/add both refuse a proven peer that has none on record. */
async function registerTestPeer(
  b: TestBroker,
  groupId: string,
  projectKey: string
): Promise<{ peerId: string; instanceToken: string }> {
  const reg = await post<{ peer_id: string; instance_token: string }>(`${b.url}/register`, {
    pid: livePid(),
    cwd: "/tmp/deck-token-authz-test",
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    client_pid: 1,
    project_key: projectKey,
    group_id: groupId,
    group_secret_hash: null,
  });
  expect(reg.status).toBe(200);
  return { peerId: reg.body.peer_id, instanceToken: reg.body.instance_token };
}

/** Boot a real server-deck.ts process against a real broker, with an
 * optional per-tile identity file (peerId, groupId, instanceToken). */
async function bootDeck(
  b: TestBroker,
  opts: { deskSession: string; identity: { peerId: string; groupId: string; instanceToken: string } | null }
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  send: (msg: unknown) => void;
}> {
  const homeDir = mkdtempSync(join(tmpdir(), "cp-deck-authz-home-"));
  dirs.push(homeDir);

  if (opts.identity) {
    await writeSessionIdentityFile(
      opts.deskSession,
      opts.identity.peerId,
      opts.identity.groupId,
      opts.identity.instanceToken,
      homeDir
    );
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    CLAUDE_PEERS_DESK_SESSION: opts.deskSession,
    // Confirmed to control os.homedir() on this platform (USERPROFILE wins
    // over HOME on win32).
    USERPROFILE: homeDir,
    HOME: homeDir,
  };

  const proc = Bun.spawn(["bun", "server-deck.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
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

  return { reader, buffer, send };
}

describe("server-deck.ts token authz", () => {
  test("PREDICTION (graph_draft_send): a matching identity file is ACCEPTED broker-side", async () => {
    const b = await startBroker();
    brokers.push(b);
    const { peerId, instanceToken } = await registerTestPeer(b, "authz-group-1", "authz-project-1");

    const h = await bootDeck(b, {
      deskSession: "authz-positive-graph",
      identity: { peerId, groupId: "authz-group-1", instanceToken },
    });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "graph_draft_send", arguments: { title: "t", prompt: "p" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.content?.[0]?.text).toContain("sent to the operator's Deck");
  }, 30_000);

  test("PREDICTION (roadmap_dispatch): a matching identity file is ACCEPTED broker-side (not an auth refusal)", async () => {
    const b = await startBroker();
    brokers.push(b);
    const { peerId, instanceToken } = await registerTestPeer(b, "authz-group-2", "authz-project-2");

    const h = await bootDeck(b, {
      deskSession: "authz-positive-dispatch",
      identity: { peerId, groupId: "authz-group-2", instanceToken },
    });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "roadmap_dispatch", arguments: {} },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    // No peer/tile to actually dispatch to -- the outcome text is whatever
    // renderDispatchOutcome says for an empty wave, but it must NOT be the
    // auth-refusal shape ("instance_token is required" / "unknown instance_token").
    // Checked against the raw TOKEN VALUE, not the field name: a message
    // that leaked the credential itself would still pass a name-only check.
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.content?.[0]?.text ?? "").not.toContain(instanceToken);
  }, 30_000);

  test("NEGATIVE CONTROL (graph_draft_send): an absent identity file is refused explicitly, never a silent success", async () => {
    const b = await startBroker();
    brokers.push(b);

    const h = await bootDeck(b, { deskSession: "authz-negative-graph", identity: null });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "graph_draft_send", arguments: { title: "t", prompt: "p" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain("instance_token is required");
  }, 30_000);

  test("NEGATIVE CONTROL (roadmap_dispatch): an absent identity file is refused explicitly, never a silent success", async () => {
    const b = await startBroker();
    brokers.push(b);

    const h = await bootDeck(b, { deskSession: "authz-negative-dispatch", identity: null });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "roadmap_dispatch", arguments: {} },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain("instance_token is required");
  }, 30_000);

  test("NEGATIVE CONTROL (post-cleanup): once server.ts's boot-time and cleanup() deletion have run, no file remains for a dead principal's token to be read from", async () => {
    const b = await startBroker();
    brokers.push(b);

    // Simulates the post-cleanup() state DIRECTLY: no file at all, which is
    // what main()'s boot-time delete and cleanup()'s own delete both
    // guarantee for a normally-exited or normally-restarted tile. graph_draft
    // -send has nothing to read and refuses the same way as the plain
    // absent-file control above.
    const h = await bootDeck(b, { deskSession: "authz-negative-stale", identity: null });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "graph_draft_send", arguments: { title: "t", prompt: "p" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
  }, 30_000);

  test("KNOWN LIMITATION, pinned not hidden: a STALE file (written before disconnect, never cleaned up) for a now-dormant principal is still ACCEPTED broker-side", async () => {
    const b = await startBroker();
    brokers.push(b);
    const { peerId, instanceToken } = await registerTestPeer(b, "authz-group-3", "authz-project-3");
    expect((await post(`${b.url}/disconnect`, { instance_token: instanceToken })).status).toBe(200);

    // This is exactly the window MAJOR 1 (boot-time deletion) closes for the
    // tile's OWN next restart, but does NOT close for a tile that never
    // restarts at all (crash with no respawn): findPeerByInstanceToken
    // (broker.ts) has no status filter, so a dormant peer's token still
    // resolves. Measuring and pinning the real behavior rather than
    // asserting a refusal that does not exist.
    const h = await bootDeck(b, {
      deskSession: "authz-stale-live-file",
      identity: { peerId, groupId: "authz-group-3", instanceToken },
    });
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "graph_draft_send", arguments: { title: "t", prompt: "p" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBeFalsy();
  }, 30_000);
});
