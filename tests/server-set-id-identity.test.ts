import { test, expect, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_OPERATOR_ID,
  groupId,
  mintRunCredential,
  scrubEnv,
  sha256Hex,
  startBroker,
  stopBroker,
  type TestBroker,
} from "./_helper.ts";
import {
  globalSessionIdentityFileName,
  readGlobalSessionIdentityFile,
  readSessionIdentityFile,
  sessionIdentityFileName,
  type SessionIdentity,
} from "../shared/peer-cache.ts";

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];
const stoppers: Array<() => void> = [];

const GLOBAL_SOCKET = "set-id-global-socket";

interface SetIdProxy {
  url: string;
  port: number;
  refuseSetId: boolean;
  snapshotPresentAtSetId: boolean[];
}

function startSetIdProxy(target: string, snapshotOnDisk: () => boolean): SetIdProxy {
  const proxy: SetIdProxy = { url: "", port: 0, refuseSetId: false, snapshotPresentAtSetId: [] };
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/set-id") {
        proxy.snapshotPresentAtSetId.push(snapshotOnDisk());
        if (proxy.refuseSetId) return Response.json({ error: "refused by the test" }, { status: 503 });
      }
      const raw = req.method === "GET" ? undefined : await req.text();
      return fetch(`${target}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: raw });
    },
  });
  stoppers.push(() => srv.stop(true));
  proxy.url = `http://127.0.0.1:${srv.port}`;
  proxy.port = srv.port as number;
  return proxy;
}

afterAll(async () => {
  for (const stop of stoppers.splice(0)) stop();
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

test.skipIf(process.platform === "darwin")("set_id updates the per-tile identity file to the renamed peer_id (publishes a global snapshot, needs a measurable process generation, refused on darwin)", async () => {
  const b = await startBroker();
  brokers.push(b);
  const homeDir = mkdtempSync(join(tmpdir(), "cp-setid-home-"));
  dirs.push(homeDir);
  const deskSession = "probe-set-id";
  const groupSecret = randomUUID();
  mkdirSync(join(homeDir, "claude-peers"), { recursive: true });
  writeFileSync(join(homeDir, "claude-peers", "config.json"), JSON.stringify({ groups: { alpha: groupSecret }, default_group: "alpha" }));
  const run = await mintRunCredential(b, { id: await groupId(groupSecret), hash: await sha256Hex(groupSecret) });
  const credential = join(homeDir, "run-credential.json");
  writeFileSync(credential, JSON.stringify({
    brokerUrl: b.url,
    operatorId: FIXTURE_OPERATOR_ID,
    tokenId: run.tokenId,
    sessionRef: `window-${run.run}`,
    privateKey: run.cred.privateKey,
    publicKey: run.cred.publicKey,
    osUserHash: "hash",
    inbox: { version: 1, run_ref: run.run, group_id: run.group },
  }));

  const globalSnapshotPath = join(homeDir, ".claude", "peers", globalSessionIdentityFileName(GLOBAL_SOCKET));
  const proxy = startSetIdProxy(b.url, () => existsSync(globalSnapshotPath));
  const proc = Bun.spawn(["bun", "server.ts"], {
    env: scrubEnv(homeDir, {
      CLAUDE_PEERS_BROKER_URL: proxy.url,
      CLAUDE_PEERS_PORT: String(proxy.port),
      CLAUDE_CODE_MESSAGING_SOCKET: GLOBAL_SOCKET,
      CLAUDE_PEERS_DESK_SESSION: deskSession,
      CLAUDE_PEERS_APPROVAL_FILE: credential,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const stderr = { text: "" };
  void (async () => {
    const decoder = new TextDecoder();
    const stderrReader = proc.stderr.getReader();
    while (true) {
      const { value, done } = await stderrReader.read();
      if (done) break;
      stderr.text += decoder.decode(value, { stream: true });
    }
  })();
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

  let initial: SessionIdentity | null = null;
  for (let i = 0; i < 80 && !initial; i++) {
    initial = await readSessionIdentityFile(deskSession, homeDir);
    if (!initial) await Bun.sleep(100);
  }
  expect(initial).not.toBeNull();

  const globalSnapshot = () => readGlobalSessionIdentityFile(GLOBAL_SOCKET, homeDir);
  let publishedGlobal: SessionIdentity | null = null;
  for (let i = 0; i < 80 && !publishedGlobal; i++) {
    publishedGlobal = await globalSnapshot();
    if (!publishedGlobal) await Bun.sleep(100);
  }
  expect(publishedGlobal?.peerId, "the boot snapshot of the global companion identity").toBe(initial!.peerId);

  const newId = "renamed-peer-c9269fef";
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "set_id", arguments: { new_id: newId } },
  });
  const res = await readUntil(reader, 1, buffer);
  expect(res.result?.isError).toBeFalsy();

  let after: SessionIdentity | null = null;
  for (let i = 0; i < 80; i++) {
    after = await readSessionIdentityFile(deskSession, homeDir);
    if (after?.peerId === newId) break;
    await Bun.sleep(100);
  }
  expect(after?.peerId).toBe(newId);
  expect(after?.inboxBinding).toEqual({ version: 1, runRef: run.run, groupId: run.group });
  expect(after?.operatorId).toBe(FIXTURE_OPERATOR_ID);
  expect(proxy.snapshotPresentAtSetId, "the global snapshot was still on disk when /set-id reached the broker").toEqual([false]);
  expect((await globalSnapshot())?.peerId, "the global snapshot names the renamed peer").toBe(newId);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "set_id", arguments: { new_id: "operator" } },
  });
  const reserved = await readUntil(reader, 2, buffer);
  expect(reserved.result?.isError).toBe(true);
  expect((await readSessionIdentityFile(deskSession, homeDir))?.inboxBinding, "a broker refusal restores the readiness snapshot").toEqual({
    version: 1,
    runRef: run.run,
    groupId: run.group,
  });
  expect(await globalSnapshot(), "a broker refusal restores the global snapshot, same peer and same instance").toMatchObject({
    peerId: newId,
    instanceToken: after!.instanceToken,
  });

  const nextId = "renamed-peer-write-failure";
  const writeBlocker = join(homeDir, ".claude", "peers", `${sessionIdentityFileName(deskSession)}.${proc.pid}.tmp`);
  mkdirSync(writeBlocker);
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "set_id", arguments: { new_id: nextId } },
  });
  const failed = await readUntil(reader, 3, buffer);
  expect(failed.result?.isError).toBe(true);
  rmSync(writeBlocker, { recursive: true });
  expect(await readSessionIdentityFile(deskSession, homeDir), "a failed snapshot write leaves no ready identity").toBeNull();
  expect(await globalSnapshot(), "a failed snapshot write after the broker renamed the peer must not leave the old global identity").toBeNull();
  for (let i = 0; i < 20 && !stderr.text.includes("set_id failed"); i++) await Bun.sleep(50);
  expect(stderr.text).toContain("set_id failed");
  expect(stderr.text).not.toContain("Could not restore the identity after set_id refusal");

  proxy.refuseSetId = true;
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "set_id", arguments: { new_id: "renamed-peer-refused-503" } },
  });
  const unavailable = await readUntil(reader, 4, buffer);
  expect(unavailable.result?.isError).toBe(true);
  expect(unavailable.result?.content?.[0]?.text).toContain("Broker error (/set-id)");
  expect(await globalSnapshot(), "a thrown broker error restores the global snapshot of the current peer").toMatchObject({
    peerId: nextId,
    instanceToken: after!.instanceToken,
  });
}, 30_000);
