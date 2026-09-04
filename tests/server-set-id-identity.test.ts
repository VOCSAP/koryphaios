// Card c9269fef lot L2-bis, MAJOR 1: set_id is a third mutator of myPeerId
// (alongside boot and switch_group) and must keep the per-tile
// session-identity file in step, or a companion process reading it after a
// rename routes a reply to whichever peer later claims the freed name.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { readSessionIdentityFile } from "../shared/peer-cache.ts";

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

test("set_id updates the per-tile identity file to the renamed peer_id", async () => {
  const b = await startBroker();
  brokers.push(b);
  const homeDir = mkdtempSync(join(tmpdir(), "cp-setid-home-"));
  dirs.push(homeDir);
  const deskSession = "probe-set-id";

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    CLAUDE_PEERS_DESK_SESSION: deskSession,
    // Confirmed to control os.homedir() on this platform (USERPROFILE wins
    // over HOME on win32) -- isolates the identity file from the real one.
    USERPROFILE: homeDir,
    HOME: homeDir,
  };

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

  // Wait for boot /register to have written the identity file at least once.
  let initial: { peerId: string; groupId: string } | null = null;
  for (let i = 0; i < 80 && !initial; i++) {
    initial = await readSessionIdentityFile(deskSession, homeDir);
    if (!initial) await Bun.sleep(100);
  }
  expect(initial).not.toBeNull();

  const newId = "renamed-peer-c9269fef";
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "set_id", arguments: { new_id: newId } },
  });
  const res = await readUntil(reader, 1, buffer);
  expect(res.result?.isError).toBeFalsy();

  let after: { peerId: string; groupId: string } | null = null;
  for (let i = 0; i < 80; i++) {
    after = await readSessionIdentityFile(deskSession, homeDir);
    if (after?.peerId === newId) break;
    await Bun.sleep(100);
  }
  expect(after?.peerId).toBe(newId);
}, 30_000);
