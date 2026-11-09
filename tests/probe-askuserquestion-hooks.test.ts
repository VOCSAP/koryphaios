import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPeersSession, DECK_ONLY_TOOLS } from "../shared/peers-session.ts";
import { scrubEnv } from "./_scrub-env.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "probe-auq-test-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROBE = join(REPO_ROOT, "scripts", "probe-askuserquestion-hooks.py");
// The probe is Python: its constants cannot be imported, only read.
const PROBE_SRC = readFileSync(PROBE, "utf-8");

const LIMIT =
  "This file runs the probe's pure --selftest only. It detects NO Claude CLI drift: hook payload " +
  "shapes, menu keys and M1/M5/M6 only change when the real CLI is replayed (TESTING.md, 'Sondes hors gate').";

function findPython(): string {
  for (const candidate of ["python3", "python", "py"]) {
    const bin = Bun.which(candidate);
    if (!bin) continue;
    const probe = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe", env: scrubEnv(SCRATCH) });
    if (probe.exitCode === 0) return bin;
  }
  throw new Error("no usable python interpreter on PATH (python3, python, py): the probe selftest cannot run");
}

function constant(name: string): string {
  const m = new RegExp(`^${name} = "([^"]+)"\\r?$`, "m").exec(PROBE_SRC);
  if (!m || !m[1]) throw new Error(`probe declares no \`${name} = "..."\` line: the cross-check below would pass on nothing`);
  return m[1];
}

test("probe --selftest passes on every check and covers the secret-leak and verdict guards", () => {
  const r = Bun.spawnSync([findPython(), PROBE, "--selftest"], { stdout: "pipe", stderr: "pipe", env: scrubEnv(SCRATCH) });
  const out = r.stdout.toString();
  const failed = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
  expect(failed, `failing selftest checks. ${LIMIT}\n${out}\n${r.stderr.toString()}`).toEqual([]);
  expect(r.exitCode, `selftest exit code. ${LIMIT}\n${out}\n${r.stderr.toString()}`).toBe(0);
  for (const mode of ["hooks", "redirect", "type"]) {
    expect(out, `no secret-leak check for mode ${mode}: a selftest with no checks would pass vacuously`).toContain(
      `ok workdir files for ${mode} never contain the secret`,
    );
  }
  for (const guard of [
    "scrub redacts the secret",
    "scrub redacts a 34-char fragment of the secret",
    "report never prints a fragment cut by the payload or screen truncation",
    "hooks: missing PermissionRequest fails",
    "type 2: Alpha fails (M5)",
    "type: keys with no expectation are inconclusive, never a pass",
    "inside_repo refuses a not yet created path under the repository",
  ]) {
    expect(out, `selftest lost the check "${guard}". ${LIMIT}`).toContain(`ok ${guard}`);
  }
});

async function peersSessionServerName(): Promise<string> {
  const home = mkdtempSync(join(SCRATCH, "session-"));
  const brokerFetch = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/register") {
      const body = JSON.parse(String(init?.body)) as { role?: string };
      return Response.json({ peer_id: "peer-1", instance_token: "token-1", inbox_binding: null, role: body.role ?? null });
    }
    if (path === "/peek-messages" || path === "/poll-messages") return Response.json({ messages: [] });
    return Response.json({ ok: true });
  };
  class IdleSocket {
    static CLOSED = 3;
    readyState = 0;
    addEventListener(): void {}
    send(): void {}
    close(): void {
      this.readyState = IdleSocket.CLOSED;
    }
  }
  const session = createPeersSession(
    {
      env: { XDG_CONFIG_HOME: home, APPDATA: home, CLAUDE_PEERS_PORT: "17999", CLAUDE_PEERS_LOG_DIR: join(home, "logs") },
      cwd: home,
      pid: 777,
      ppid: 4242,
      stdinIsTty: false,
    },
    {
      log: { log: () => {}, logError: () => {} },
      home,
      hostname: () => "test-host",
      ensureBroker: async () => {},
      measureWriterGeneration: async () => null,
      settings: {
        contextResumeKeyTtlMs: 300_000,
        pollFallbackIntervalMs: 3_600_000,
        heartbeatIntervalMs: 3_600_000,
        disconnectBoundMs: 3_000,
        wsReconnectInitialMs: 60_000,
      },
      fetch: brokerFetch as unknown as typeof fetch,
      WebSocket: IdleSocket as unknown as typeof WebSocket,
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "probe-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    await session.ready;
    return client.getServerVersion()?.name ?? "";
  } finally {
    await client.close();
    await session.close("bye");
  }
}

test("the MCP server the probe names is the peers session's own server", async () => {
  const serverName = await peersSessionServerName();
  expect(serverName, `the probe addresses server "${constant("MCP_SERVER")}", the peers session serves as "${serverName}"`).toBe(
    constant("MCP_SERVER"),
  );
});

test("the tool the probe tells the agent to call is declared by the operator tool family", () => {
  const declared = DECK_ONLY_TOOLS.map((tool) => tool.name);
  expect(declared, `no operator-family tool "${constant("MCP_TOOL")}": the probe's deny reason points at nothing`).toContain(
    constant("MCP_TOOL"),
  );
});

