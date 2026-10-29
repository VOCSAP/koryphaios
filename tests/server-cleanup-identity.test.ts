import { test, expect, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
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
import { readSessionIdentityFile, sessionIdentityFileName, writeSessionIdentityFile } from "../shared/peer-cache.ts";

/** Scans EVERY file left in `dir`, not just the expected path: a deletion
 * mutated into a `rename` to a neighboring name would still pass a
 * single-path `access().rejects` check while the secret survives on disk
 * under a different filename. */
async function assertSecretNotOnDisk(dir: string, secret: string): Promise<void> {
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    const content = await readFile(join(dir, f), "utf-8").catch(() => "");
    expect(content).not.toContain(secret);
  }
}

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

interface LaunchedServer {
  proc: ReturnType<typeof Bun.spawn>;
  homeDir: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  stderr: { text: string };
}

async function launchServer(
  b: TestBroker,
  deskSession: string,
  env: Record<string, string>,
  opts: { cwd?: string; seed?: (homeDir: string) => Promise<void> } = {}
): Promise<LaunchedServer> {
  const homeDir = mkdtempSync(join(tmpdir(), "cp-cleanup-home-"));
  dirs.push(homeDir);
  await opts.seed?.(homeDir);
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

  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
    env: scrubEnv(homeDir, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_DESK_SESSION: deskSession,
      CLAUDE_PEERS_APPROVAL_FILE: credential,
      ...env,
    }),
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const stderr = { text: "" };
  const errReader = proc.stderr.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await errReader.read();
      if (done) return;
      stderr.text += decoder.decode(value, { stream: true });
    }
  })();
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { roots: {}, elicitation: {} },
        clientInfo: { name: "test-harness", version: "0.0.1" },
      },
    }) + "\n"
  );
  await readUntil(reader, 0, buffer);
  return { proc, homeDir, reader, buffer, stderr };
}

test("cleanup() (triggered by stdin close, the same path Claude Code exiting takes) deletes the identity file", async () => {
  const b = await startBroker();
  brokers.push(b);
  const deskSession = "probe-cleanup";
  // The tile cwd equals the server's cwd: the guard must let a legitimate tile through.
  const { proc, homeDir } = await launchServer(b, deskSession, { CLAUDE_PEERS_DESK_TILE_CWD: process.cwd() });

  let before: { peerId: string; groupId: string; instanceToken: string } | null = null;
  for (let i = 0; i < 80 && !before; i++) {
    before = await readSessionIdentityFile(deskSession, homeDir);
    if (!before) await Bun.sleep(100);
  }
  expect(before).not.toBeNull();

  // Same shutdown path Claude Code closing the session takes
  // (process.stdin.on("end") -> stdinShutdown -> cleanup()).
  await proc.stdin.end();
  await proc.exited;

  const peersDir = join(homeDir, ".claude", "peers");
  await expect(access(join(peersDir, sessionIdentityFileName(deskSession)))).rejects.toThrow();
  await assertSecretNotOnDisk(peersDir, before!.instanceToken);
}, 30_000);

test("a server started in another cwd with the tile's token neither overwrites nor deletes the tile's identity file", async () => {
  const b = await startBroker();
  brokers.push(b);
  const deskSession = "probe-foreign-cwd";
  const tileCwd = mkdtempSync(join(tmpdir(), "cp-tile-cwd-"));
  const foreignCwd = mkdtempSync(join(tmpdir(), "cp-foreign-cwd-"));
  dirs.push(tileCwd, foreignCwd);
  const peersDirOf = (home: string): string => join(home, ".claude", "peers");
  const tileFile = (home: string): string => join(peersDirOf(home), sessionIdentityFileName(deskSession));

  const { proc, homeDir, stderr } = await launchServer(
    b,
    deskSession,
    { CLAUDE_PEERS_DESK_TILE_CWD: tileCwd },
    {
      cwd: foreignCwd,
      seed: async (home) => {
        await writeSessionIdentityFile(deskSession, "tile-peer", "tile-group", "tile-secret", home);
      },
    }
  );
  const sealed = await readFile(tileFile(homeDir), "utf-8");

  const deadline = Date.now() + 20_000;
  while (!stderr.text.includes("Refused to write the session-identity file")) {
    if (Date.now() > deadline) throw new Error(`the foreign-cwd server never refused its write; stderr: ${stderr.text.slice(-500)}`);
    await Bun.sleep(50);
  }
  await proc.stdin.end();
  await proc.exited;

  const deleteRefusals = (): number => stderr.text.match(/Refused to delete the session-identity file/g)?.length ?? 0;
  const drained = Date.now() + 5_000;
  while (deleteRefusals() < 2 && Date.now() < drained) await Bun.sleep(20);

  expect(await readFile(tileFile(homeDir), "utf-8"), "the tile's file survives boot, register and exit byte for byte").toBe(sealed);
  expect(deleteRefusals(), "boot delete and cleanup delete are both refused").toBe(2);
}, 40_000);
