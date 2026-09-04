// Card c9269fef lot L3: cleanup() must delete the per-tile identity file
// alongside its /disconnect POST -- unlike peer_id/group_id, the
// instance_token has no status filter downstream (findPeerByInstanceToken),
// so a token surviving past disconnect would let a companion process act as
// a peer that is actually dead.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { readSessionIdentityFile, sessionIdentityFileName } from "../shared/peer-cache.ts";

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

test("cleanup() (triggered by stdin close, the same path Claude Code exiting takes) deletes the identity file", async () => {
  const b = await startBroker();
  brokers.push(b);
  const homeDir = mkdtempSync(join(tmpdir(), "cp-cleanup-home-"));
  dirs.push(homeDir);
  const deskSession = "probe-cleanup";

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    CLAUDE_PEERS_DESK_SESSION: deskSession,
    USERPROFILE: homeDir,
    HOME: homeDir,
  };

  const proc = Bun.spawn(["bun", "server.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
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
