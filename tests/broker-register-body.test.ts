// bun server.ts must be spawned with the absolute path to server.ts: the temp
// non-git cwd under test would otherwise resolve a relative path against
// itself, not the repo.
// Never SELECT ... LIMIT 1 on peers with no WHERE clause: dormant sentinel rows
// seeded with cwd = '' can be picked up instead of the session under test;
// filter status = 'active' AND cwd <> ''.

import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { resolveProjectKey } from "../shared/project-key.ts";

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
  const deadline = Date.now() + 15_000;
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

const SERVER_PATH = resolve(import.meta.dir, "..", "server.ts");

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const tmpDirs: string[] = [];

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
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

interface PeerRow {
  cwd: string;
  git_root: string | null;
  project_key: string | null;
}

test(
  "server.ts's /register body carries roadmapProjectKey()'s resolved value, not the raw possibly-null myProjectKey",
  async () => {
    const b = await startBroker();
    brokers.push(b);

    // A fresh temp dir under the OS tmpdir, no .git anywhere in its ancestry:
    // no remote, no git root, so the fallback path (local:<hash>) is the one
    // exercised -- exactly the shape that regressed for card 6aa32af4.
    const sessionCwd = mkdtempSync(join(tmpdir(), "cp-register-body-"));
    tmpDirs.push(sessionCwd);

    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PEERS_"))
    ) as Record<string, string>;

    const proc = Bun.spawn(["bun", SERVER_PATH], {
      cwd: sessionCwd,
      env: {
        ...cleanEnv,
        CLAUDE_PEERS_BROKER_URL: b.url,
        CLAUDE_PEERS_PORT: String(b.port),
      },
      // stdin must stay an open pipe, not "ignore" (= /dev/null): an
      // immediate EOF on stdin makes server.ts read it as "Claude Code
      // closed" and shut down right after registering, flipping the row
      // dormant before the poll below can observe it active (measured: a
      // 10s timeout on every run with "ignore", instant pass with "pipe").
      // stdout is now piped too (below: a real MCP handshake for whoami).
      stdio: ["pipe", "pipe", "ignore"],
    });
    procs.push(proc);
    const stdout = proc.stdout.getReader();
    const rpcBuffer = { text: "" };
    let nextRpcId = 1;

    const db = new Database(b.dbPath);
    const deadline = Date.now() + 10_000;
    let row: PeerRow | undefined;
    while (Date.now() < deadline) {
      row = db
        .query(
          "SELECT cwd, git_root, project_key FROM peers WHERE status = 'active' AND cwd <> '' LIMIT 1"
        )
        .get() as PeerRow | undefined;
      if (row) break;
      await Bun.sleep(100);
    }
    db.close();

    if (!row) {
      throw new Error("timed out waiting for server.ts to register with the test broker");
    }

    // Reconstruct the expected key from what the broker actually stored for
    // cwd/git_root, not from a path string built on the test side -- avoids
    // any host path-spelling mismatch (8.3 short name, symlink) between this
    // process and the spawned one; see project_windows_symlink_privilege_blocked
    // memory for why that class of comparison is otherwise unsafe to assume.
    const expected = resolveProjectKey(null, row.git_root, row.cwd);
    expect(row.project_key).toBe(expected);
    expect(row.project_key).not.toBeNull();

    // whoami's project_key must agree with what /register just stored --
    // reviewer-flagged gap (2nd round): it used to echo the raw, possibly-
    // null myProjectKey instead of roadmapProjectKey()'s resolved value,
    // contradicting list_peers for this exact peer on a no-remote repo.
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
    await readUntil(stdout, 0, rpcBuffer);

    const whoamiId = nextRpcId++;
    send({ jsonrpc: "2.0", id: whoamiId, method: "tools/call", params: { name: "whoami", arguments: {} } });
    const whoamiRes = await readUntil(stdout, whoamiId, rpcBuffer);
    const whoamiJson = JSON.parse(whoamiRes.result?.content?.[0]?.text ?? "{}") as { project_key: string | null };
    expect(whoamiJson.project_key).toBe(expected);
  },
  20_000
);
