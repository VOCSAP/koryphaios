// PLAN-v0.4 C5: the Deck control endpoint (desktop/src/main/deck-control) and
// the deck-control MCP stdio bridge (desktop/mcp/deck-control-mcp.ts).
// The endpoint runs with FAKE deps so dispatch + guard logic is tested without
// electron/node-pty; the MCP server is spawned for real (bun runs the TS) and
// spoken to over newline-delimited JSON-RPC.

import { test, expect, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import {
  startDeckControl,
  SPAWN_CAP,
  type DeckControlDeps,
  type DeckControlServer
} from "../desktop/src/main/deck-control.ts";
import {
  writeSupervisorMcpConfig,
  SUPERVISOR_BRIEFING
} from "../desktop/src/main/supervisor.ts";
import type { CreateSessionInput, SessionRuntime } from "../desktop/src/shared/types.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const servers: DeckControlServer[] = [];
const procs: Subprocess[] = [];
const tmpDirs: string[] = [];

afterAll(() => {
  for (const s of servers) s.close();
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function fakeSession(id: string, extra: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    id,
    name: id,
    cwd: "/proj",
    command: "",
    args: "",
    sessionId: `sid-${id}`,
    color: "#fff",
    createdAt: 0,
    status: "running",
    exitCode: null,
    pid: 1,
    peerId: `peer-${id}`,
    thinking: false,
    expired: false,
    rateLimited: false,
    resumeAt: null,
    ...extra
  };
}

function makeDeps(state: { sessions: SessionRuntime[] }): DeckControlDeps & {
  closed: string[];
  removedWt: string[];
} {
  const closed: string[] = [];
  const removedWt: string[] = [];
  let n = 0;
  return {
    closed,
    removedWt,
    listAgents: () => ["team-lead", "dev", "reviewer"],
    listModels: () => [{ id: "opus", label: "Opus" }],
    listPresets: () => [],
    spawnSession: async (input: CreateSessionInput) => {
      const s = fakeSession(`spawned-${++n}`, {
        name: input.name ?? "peer",
        worktree: input.worktreeBranch
          ? { path: `/proj/.worktrees/${input.worktreeBranch}`, branch: input.worktreeBranch }
          : undefined
      });
      state.sessions.push(s);
      return s;
    },
    listSessions: () => state.sessions,
    restartSession: () => undefined,
    closeSession: (id) => {
      closed.push(id);
      state.sessions = state.sessions.filter((s) => s.id !== id);
    },
    createWorktree: async (branch) => ({ path: `/proj/.worktrees/${branch}`, branch, main: false }),
    listWorktrees: async () => [{ path: "/proj", branch: "main", main: true }],
    removeWorktree: async (path) => {
      removedWt.push(path);
    },
    listTemplates: () => [{ path: "/t.json", name: "team", source: "global", sessionCount: 2 }],
    applyTemplate: async () => 2,
    saveTemplate: (name) => `/templates/${name}.json`,
    announce: async () => 3
  };
}

async function call(
  srv: DeckControlServer,
  tool: string,
  args: Record<string, unknown> = {},
  token?: string
): Promise<{ status: number; body: { ok: boolean; result?: unknown; error?: string } }> {
  const res = await fetch(`${srv.url}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token ?? srv.token}`
    },
    body: JSON.stringify({ tool, args })
  });
  return { status: res.status, body: (await res.json()) as never };
}

test("rejects a missing/wrong bearer token", async () => {
  const srv = await startDeckControl(makeDeps({ sessions: [] }));
  servers.push(srv);
  const res = await fetch(`${srv.url}/call`, { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
  const wrong = await call(srv, "deck_list_agents", {}, "nope");
  expect(wrong.status).toBe(401);
});

test("dispatches list tools and spawn; unknown tool errors", async () => {
  const state = { sessions: [] as SessionRuntime[] };
  const srv = await startDeckControl(makeDeps(state));
  servers.push(srv);

  const agents = await call(srv, "deck_list_agents");
  expect(agents.body).toEqual({ ok: true, result: { agents: ["team-lead", "dev", "reviewer"] } });

  const spawned = await call(srv, "deck_spawn_session", {
    name: "dev-1",
    agent: "dev",
    worktree_branch: "agent/x",
    prompt: "do the thing"
  });
  expect(spawned.body.ok).toBe(true);
  const session = (spawned.body.result as { session: { id: string; worktree_branch: string } })
    .session;
  expect(session.worktree_branch).toBe("agent/x");

  const listed = await call(srv, "deck_list_sessions");
  expect((listed.body.result as { sessions: unknown[] }).sessions.length).toBe(1);

  const unknown = await call(srv, "deck_nope");
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toContain("unknown tool");
});

test("guards: close/remove only touch supervisor-created objects; spawn cap", async () => {
  const state = { sessions: [fakeSession("operator-1")] };
  const deps = makeDeps(state);
  const srv = await startDeckControl(deps);
  servers.push(srv);

  // Closing an operator session is refused.
  const refused = await call(srv, "deck_close_session", { id: "operator-1" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("refused");
  expect(deps.closed).toEqual([]);

  // A supervisor-spawned session can be closed.
  const spawned = await call(srv, "deck_spawn_session", { name: "mine" });
  const id = (spawned.body.result as { session: { id: string } }).session.id;
  const ok = await call(srv, "deck_close_session", { id });
  expect(ok.body.ok).toBe(true);
  expect(deps.closed).toEqual([id]);

  // Worktrees: same ownership rule.
  const wtRefused = await call(srv, "deck_remove_worktree", { path: "/proj/.worktrees/foreign" });
  expect(wtRefused.status).toBe(400);
  const wt = await call(srv, "deck_create_worktree", { branch: "agent/z" });
  const wtPath = (wt.body.result as { worktree: { path: string } }).worktree.path;
  const wtOk = await call(srv, "deck_remove_worktree", { path: wtPath });
  expect(wtOk.body.ok).toBe(true);
  expect(deps.removedWt).toEqual([wtPath]);

  // Spawn cap: fill up to SPAWN_CAP live sessions, next spawn refused.
  while (state.sessions.filter((s) => s.status !== "exited").length < SPAWN_CAP) {
    state.sessions.push(fakeSession(`filler-${state.sessions.length}`));
  }
  const capped = await call(srv, "deck_spawn_session", { name: "one-too-many" });
  expect(capped.status).toBe(400);
  expect(capped.body.error).toContain("spawn cap");
});

// ----- supervisor mcp-config file -----

test("writeSupervisorMcpConfig writes a valid --mcp-config with env bridge", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-sup-"));
  tmpDirs.push(dir);
  const file = writeSupervisorMcpConfig({
    dir,
    mcpScriptPath: "/res/deck-plugin/mcp/deck-control-mcp.mjs",
    execPath: "/usr/bin/electron",
    controlUrl: "http://127.0.0.1:1234",
    controlToken: "tok"
  });
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
    mcpServers: Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >;
  };
  const server = parsed.mcpServers["deck-control"]!;
  expect(server.command).toBe("/usr/bin/electron");
  expect(server.args).toEqual(["/res/deck-plugin/mcp/deck-control-mcp.mjs"]);
  expect(server.env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(server.env.DECK_CONTROL_URL).toBe("http://127.0.0.1:1234");
  expect(server.env.DECK_CONTROL_TOKEN).toBe("tok");
  expect(SUPERVISOR_BRIEFING).toContain("deck_list_agents");
});

// ----- MCP stdio bridge, end to end against a real control endpoint -----

test("deck-control-mcp speaks MCP over stdio and forwards tools/call", async () => {
  const state = { sessions: [] as SessionRuntime[] };
  const srv = await startDeckControl(makeDeps(state));
  servers.push(srv);

  const proc = Bun.spawn(["bun", "desktop/mcp/deck-control-mcp.ts"], {
    env: {
      ...process.env,
      DECK_CONTROL_URL: srv.url,
      DECK_CONTROL_TOKEN: srv.token
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore"
  });
  procs.push(proc);

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function readMessage(): Promise<Record<string, unknown>> {
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) return JSON.parse(line) as Record<string, unknown>;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("mcp server closed");
      buffer += decoder.decode(value);
    }
  }
  function sendMessage(msg: unknown): void {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    void proc.stdin.flush();
  }

  sendMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }
  });
  const init = (await readMessage()) as { result: { serverInfo: { name: string } } };
  expect(init.result.serverInfo.name).toBe("deck-control");

  sendMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (await readMessage()) as { result: { tools: { name: string }[] } };
  const names = tools.result.tools.map((t) => t.name);
  expect(names).toContain("deck_spawn_session");
  expect(names).toContain("deck_announce");

  sendMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "deck_list_agents", arguments: {} }
  });
  const result = (await readMessage()) as {
    result: { content: { type: string; text: string }[]; isError?: boolean };
  };
  expect(result.result.isError).toBeUndefined();
  expect(result.result.content[0]!.text).toContain("team-lead");

  // A guarded refusal comes back as an isError tool result, not a crash.
  sendMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "deck_close_session", arguments: { id: "not-owned" } }
  });
  const refused = (await readMessage()) as { result: { isError?: boolean } };
  expect(refused.result.isError).toBe(true);
});
