// REC scripted-scenario lot: the per-run demo-control endpoint
// (desktop/src/main/demo-control.ts) and the demo-browser MCP stdio bridge
// (desktop/mcp/demo-browser-mcp.ts). Fake driver deps (no electron); the MCP
// server is spawned for real (bun runs the TS), mirroring the deck-control
// suite.

import { test, expect, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import {
  startDemoControl,
  DEMO_STEP_CAP,
  type DemoControlDeps,
  type DemoControlServer
} from "../desktop/src/main/demo-control.ts";

const servers: DemoControlServer[] = [];
const procs: Subprocess[] = [];

afterAll(() => {
  for (const s of servers) s.close();
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* */
    }
  }
});

interface CallLog {
  navigations: string[];
  clicks: string[];
  typed: { text: string; selector?: string; pressEnter?: boolean }[];
  waits: { ms?: number; selector?: string }[];
  reads: number;
}

function makeDeps(log: CallLog): DemoControlDeps {
  return {
    navigate: async (url) => {
      log.navigations.push(url);
      return { url, title: "t" };
    },
    click: async (selector) => {
      log.clicks.push(selector);
      return { clicked: true };
    },
    type: async (text, opts) => {
      log.typed.push({ text, ...opts });
      return { typed: true };
    },
    read: async () => {
      log.reads++;
      return { url: "http://x/", title: "t", text: "", interactive: [] };
    },
    wait: async (opts) => {
      log.waits.push(opts);
      return { ok: true };
    }
  };
}

function emptyLog(): CallLog {
  return { navigations: [], clicks: [], typed: [], waits: [], reads: 0 };
}

async function call(
  srv: DemoControlServer,
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

test("auth: a wrong token is rejected before any dispatch", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);
  const res = await call(srv, "demo_read", {}, "not-the-token");
  expect(res.status).toBe(401);
  expect(log.reads).toBe(0);
});

test("dispatches the five demo tools; bad args and unknown tools error", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);

  expect((await call(srv, "demo_navigate", { url: "http://localhost:3000/" })).body.ok).toBe(true);
  expect((await call(srv, "demo_click", { selector: "#go" })).body.ok).toBe(true);
  expect(
    (await call(srv, "demo_type", { text: "hello", selector: "#q", press_enter: true })).body.ok
  ).toBe(true);
  expect((await call(srv, "demo_read")).body.ok).toBe(true);
  expect((await call(srv, "demo_wait", { ms: 5 })).body.ok).toBe(true);
  expect((await call(srv, "demo_wait", { selector: ".done" })).body.ok).toBe(true);

  expect(log.navigations).toEqual(["http://localhost:3000/"]);
  expect(log.clicks).toEqual(["#go"]);
  expect(log.typed).toEqual([{ text: "hello", selector: "#q", pressEnter: true }]);
  expect(log.waits).toEqual([{ ms: 5, selector: undefined }, { ms: undefined, selector: ".done" }]);

  expect((await call(srv, "demo_navigate", {})).body.error).toContain("url is required");
  expect((await call(srv, "demo_click", {})).body.error).toContain("selector is required");
  expect((await call(srv, "demo_type", {})).body.error).toContain("text is required");
  expect((await call(srv, "demo_wait", {})).body.error).toContain("ms or selector");
  expect((await call(srv, "demo_wait", { ms: "soon" })).body.error).toContain("ms or selector");
  expect((await call(srv, "deck_spawn_session", {})).body.error).toContain("unknown tool");
});

test("step cap: beyond DEMO_STEP_CAP every call errors", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);
  for (let i = 0; i < DEMO_STEP_CAP; i++) {
    expect((await call(srv, "demo_read")).body.ok).toBe(true);
  }
  const over = await call(srv, "demo_read");
  expect(over.body.ok).toBe(false);
  expect(over.body.error).toContain("step cap");
  expect(log.reads).toBe(DEMO_STEP_CAP);
});

// ----- Self-review nudges (Chantier OD6, DESIGN-ORCA-DOOP-ADOPTION.md §4.1) -----

test("demo_navigate: result always carries the read-again reminder", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);
  const res = await call(srv, "demo_navigate", { url: "http://localhost:3000/" });
  const body = res.body.result as { url: string; reminder?: string };
  expect(body.url).toBe("http://localhost:3000/");
  expect(body.reminder).toContain("call demo_read before your next action");
});

test("demo_click: no reminder on the first two clicks, reminder from the third (stale-read threshold)", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);

  const first = (await call(srv, "demo_click", { selector: "#a" })).body.result as {
    reminder?: string;
  };
  expect(first.reminder).toBeUndefined();

  const second = (await call(srv, "demo_click", { selector: "#b" })).body.result as {
    reminder?: string;
  };
  expect(second.reminder).toBeUndefined();

  const third = (await call(srv, "demo_click", { selector: "#c" })).body.result as {
    reminder?: string;
  };
  expect(third.reminder).toContain("3 actions since your last demo_read");
});

test("demo_read resets the stale-action counter: click, click, read, click -> last click carries none", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);

  await call(srv, "demo_click", { selector: "#a" });
  await call(srv, "demo_click", { selector: "#b" });
  await call(srv, "demo_read");
  const afterRead = (await call(srv, "demo_click", { selector: "#c" })).body.result as {
    reminder?: string;
  };
  expect(afterRead.reminder).toBeUndefined();
});

test("demo_read and demo_wait never carry a reminder", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);

  // Push well past the stale-read threshold first.
  await call(srv, "demo_click", { selector: "#a" });
  await call(srv, "demo_click", { selector: "#b" });
  await call(srv, "demo_click", { selector: "#c" });

  const read = (await call(srv, "demo_read")).body.result as Record<string, unknown>;
  expect(read).not.toHaveProperty("reminder");

  const wait = (await call(srv, "demo_wait", { ms: 1 })).body.result as Record<string, unknown>;
  expect(wait).not.toHaveProperty("reminder");
});

test("a non-object dep result is wrapped as { result, reminder } rather than spread", async () => {
  const log = emptyLog();
  const deps = makeDeps(log);
  deps.navigate = async (url) => {
    log.navigations.push(url);
    return url; // a plain string, not an object
  };
  const srv = await startDemoControl(deps);
  servers.push(srv);
  const res = await call(srv, "demo_navigate", { url: "http://localhost:3000/" });
  const body = res.body.result as { result: string; reminder?: string };
  expect(body.result).toBe("http://localhost:3000/");
  expect(body.reminder).toContain("call demo_read before your next action");
});

test("a result with no reminder attached is returned bit-identical (not re-wrapped)", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);
  const res = await call(srv, "demo_read");
  expect(res.body.result).toEqual({ url: "http://x/", title: "t", text: "", interactive: [] });
});

test("demo-browser-mcp speaks MCP over stdio and forwards tools/call", async () => {
  const log = emptyLog();
  const srv = await startDemoControl(makeDeps(log));
  servers.push(srv);

  const proc = Bun.spawn(["bun", "desktop/mcp/demo-browser-mcp.ts"], {
    env: { ...process.env, DEMO_CONTROL_URL: srv.url, DEMO_CONTROL_TOKEN: srv.token },
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
  const init = (await readMessage()) as {
    result: { serverInfo: { name: string }; instructions: string };
  };
  expect(init.result.serverInfo.name).toBe("demo-browser");
  expect(init.result.instructions).toContain("RECORDED");

  sendMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (await readMessage()) as { result: { tools: { name: string }[] } };
  expect(tools.result.tools.map((t) => t.name).sort()).toEqual([
    "demo_click",
    "demo_navigate",
    "demo_read",
    "demo_type",
    "demo_wait"
  ]);

  sendMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "demo_click", arguments: { selector: "#hero" } }
  });
  const clicked = (await readMessage()) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  expect(clicked.result.isError).toBeUndefined();
  expect(log.clicks).toEqual(["#hero"]);

  // A dispatch failure comes back as an isError tool result, not a crash.
  sendMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "demo_navigate", arguments: {} }
  });
  const failed = (await readMessage()) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  expect(failed.result.isError).toBe(true);
  expect(failed.result.content[0]!.text).toContain("url is required");
});
