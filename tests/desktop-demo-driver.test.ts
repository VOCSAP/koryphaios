// REC scripted-scenario lot: demo-driver command/harness composition
// (desktop/src/main/demo-driver.ts). The harness is a C8 code constant; the
// operator scenario is data on the command line, capped and quoted.

import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { extractBracedBody } from "./_braced-body";
import {
  buildDemoCommand,
  DEMO_DISALLOWED_TOOLS,
  DEMO_PEER_TOOLS,
  DEMO_SYSTEM_PROMPT,
  MAX_SCENARIO_CHARS,
  mintDemoTile,
  pickEmbeddedBrowser,
  readUserMcpServers,
  writeDemoMcpConfig,
  writeDemoScenarioFile,
  writeDemoSystemPrompt
} from "../desktop/src/main/demo-driver.ts";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

test("buildDemoCommand composes the full claude harness, scenario fed via stdinFromFile (D5)", () => {
  const cmd = buildDemoCommand({
    scenarioFile: "/state/demo-scenario.md",
    systemPromptFile: "/state/demo-system-prompt.md",
    mcpConfigPath: "/state/demo-mcp.json",
    model: "sonnet",
    platform: "linux"
  });
  expect(cmd.startsWith("claude -p ")).toBe(true);
  // The scenario is never inlined on the command line (07dc42c0): only its
  // file path, piped in via stdinFromFile.
  expect(cmd).toContain('< "/state/demo-scenario.md"');
  expect(cmd).toContain('--append-system-prompt-file "/state/demo-system-prompt.md"');
  expect(cmd).toContain("--model sonnet");
  expect(cmd).toContain('--mcp-config "/state/demo-mcp.json"');
  expect(cmd).toContain("--strict-mcp-config");
  expect(cmd).toContain(`--disallowedTools "${DEMO_DISALLOWED_TOOLS}"`);
});

test("a bad model id is dropped, never spliced into the command", () => {
  const cmd = buildDemoCommand({
    scenarioFile: "/s-scenario.md",
    systemPromptFile: "/s.md",
    mcpConfigPath: "/m.json",
    model: 'sonnet"; rm -rf /',
    platform: "linux"
  });
  expect(cmd).not.toContain("--model");
  expect(cmd).not.toContain("rm -rf");
});

test("writeDemoScenarioFile caps an oversized scenario and writes it to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-scenario-"));
  tmpDirs.push(dir);
  const file = writeDemoScenarioFile(dir, "x".repeat(MAX_SCENARIO_CHARS + 500));
  const written = readFileSync(file, "utf-8");
  expect(written.length).toBe(MAX_SCENARIO_CHARS);
  expect(written).not.toContain("x".repeat(MAX_SCENARIO_CHARS + 1));
});

test("the demo agent has no file/shell/web tools left", () => {
  for (const tool of ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "WebFetch", "Task", "Agent", "Skill"]) {
    expect(DEMO_DISALLOWED_TOOLS.split(",")).toContain(tool);
  }
});

test("writeDemoMcpConfig writes a valid --mcp-config with the env bridge", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-mcp-"));
  tmpDirs.push(dir);
  const file = writeDemoMcpConfig({
    dir,
    mcpScriptPath: "/res/deck-plugin/mcp/demo-browser-mcp.mjs",
    execPath: "/usr/lib/electron",
    controlUrl: "http://127.0.0.1:4242",
    controlToken: "tok"
  });
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = parsed.mcpServers["demo-browser"]!;
  expect(server.command).toBe("/usr/lib/electron");
  expect(server.args).toEqual(["/res/deck-plugin/mcp/demo-browser-mcp.mjs"]);
  expect(server.env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(server.env.DEMO_CONTROL_URL).toBe("http://127.0.0.1:4242");
  expect(server.env.DEMO_CONTROL_TOKEN).toBe("tok");
});

function fakeGuest(opts: { type?: string; host?: unknown; destroyed?: boolean; id?: number } = {}): WebContents {
  return {
    id: opts.id ?? 1,
    isDestroyed: () => opts.destroyed === true,
    getType: () => opts.type ?? "webview",
    hostWebContents: opts.host
  } as unknown as WebContents;
}

test("pickEmbeddedBrowser returns the one webview hosted by the Deck window and refuses every other count", () => {
  const host = fakeGuest({ type: "window" });
  const mine = fakeGuest({ host });
  expect(pickEmbeddedBrowser([host, mine], host)).toEqual({ ok: true, guest: mine });

  const none = pickEmbeddedBrowser([host], host);
  expect(none.ok).toBe(false);
  expect(none.ok ? "" : none.reason).toContain("not open");

  const two = pickEmbeddedBrowser([mine, fakeGuest({ host })], host);
  expect(two.ok).toBe(false);
  expect(two.ok ? "" : two.reason).toContain("more than one");

  // A webview of another window, or a destroyed one, is not this Deck's browser.
  expect(pickEmbeddedBrowser([fakeGuest({ host: { id: 99 } }), fakeGuest({ host, destroyed: true })], host).ok).toBe(false);
  expect(pickEmbeddedBrowser([mine], null).ok).toBe(false);
});

// ipc.ts imports electron, so the handler cannot run under bun: one bounded anchor on its body.
test("the browser:demo-run handler claims the embedded browser before any await, refuses with an error, and releases in a finally", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts"), "utf-8");
  const at = source.indexOf("'browser:demo-run'");
  expect(at).toBeGreaterThan(-1);
  const body = extractBracedBody(source, source.indexOf("=> {", at) + 3);
  const claim = body.indexOf("acquireDemoBrowser()");
  expect(claim, "the handler must claim the slot").toBeGreaterThan(-1);
  expect(body.slice(0, claim), "no await may precede the claim: a tile spawn could slip in").not.toContain("await ");
  expect(claim).toBeLessThan(body.indexOf("startDemoControl("));
  expect(body.slice(claim, claim + 300)).toContain("throw new Error(");
  expect(body, "the claim is released whatever happens").toMatch(/finally\s*\{\s*claim\.release\(\)/);
});

test("pickEmbeddedBrowser recognises the host by id, not by wrapper identity", () => {
  const host = fakeGuest({ type: "window", id: 7 });
  const guest = fakeGuest({ host: { id: 7 } });
  expect(pickEmbeddedBrowser([host, guest], host)).toEqual({ ok: true, guest });
});

const USER_SERVERS = {
  "claude-peers": { command: "bun", args: ["/home/u/koryphaios/server.ts"], env: { CLAUDE_PEERS_TOOLS: "roadmap_add,set_id", KEEP: "1" } },
  "kory-roadmap": { command: "bun", args: ["/home/u/koryphaios/server-roadmap.ts"] },
  "kory-deck": { command: "bun", args: ["/deck.mjs"] },
  "crawl4ai-rag": { type: "http", url: "http://127.0.0.1:1/mcp" }
};

function mintInput(
  dir: string,
  guests: WebContents[],
  host: WebContents,
  reports: string[] = [],
  userServers: unknown = USER_SERVERS
) {
  return {
    guests,
    host,
    readUserMcpServers: () => userServers,
    report: (scope: string, message: string) => {
      reports.push(`${scope} ${message}`);
    },
    writeConfig: (control: { url: string; token: string }, fileName: string, globals: Record<string, unknown>) =>
      writeDemoMcpConfig({
        dir,
        mcpScriptPath: "/res/deck-plugin/mcp/demo-browser-mcp.mjs",
        execPath: "/usr/lib/electron",
        controlUrl: control.url,
        controlToken: control.token,
        fileName,
        extraServers: globals
      })
  };
}

type TileConfig = { mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };

test("a demo tile is closed: exactly demo-browser, claude-peers and kory-roadmap, whatever else the user config holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-closed-"));
  tmpDirs.push(dir);
  const host = fakeGuest({ type: "window" });
  const mint = await mintDemoTile(mintInput(dir, [host, fakeGuest({ host })], host));
  try {
    const config = JSON.parse(readFileSync(mint.mcpConfig, "utf-8")) as TileConfig;
    expect(Object.keys(config.mcpServers).sort()).toEqual(["claude-peers", "demo-browser", "kory-roadmap"]);
  } finally {
    mint.release();
  }
});

test("the copied globals carry the demo CLAUDE_PEERS_TOOLS over whatever the user entry declared, and keep the rest as is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-env-"));
  tmpDirs.push(dir);
  const host = fakeGuest({ type: "window" });
  const mint = await mintDemoTile(mintInput(dir, [host, fakeGuest({ host })], host));
  try {
    const { mcpServers } = JSON.parse(readFileSync(mint.mcpConfig, "utf-8")) as TileConfig;
    const demoList = DEMO_PEER_TOOLS.join(",");
    expect(mcpServers["claude-peers"]!.env!.CLAUDE_PEERS_TOOLS, "an entry's own list never widens the demo").toBe(demoList);
    expect(mcpServers["kory-roadmap"]!.env!.CLAUDE_PEERS_TOOLS, "an entry with no env still gets the list").toBe(demoList);
    expect(mcpServers["claude-peers"]!.env!.KEEP).toBe("1");
    expect(mcpServers["claude-peers"]!.command).toBe("bun");
    expect(mcpServers["claude-peers"]!.args).toEqual(["/home/u/koryphaios/server.ts"]);
    expect(mcpServers["demo-browser"]!.args).toEqual(["/res/deck-plugin/mcp/demo-browser-mcp.mjs"]);
  } finally {
    mint.release();
  }
});

test("a user entry's CLAUDE_PEERS_TOOLS is dropped under any casing, so only the demo list reaches the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-case-"));
  tmpDirs.push(dir);
  const host = fakeGuest({ type: "window" });
  const userServers = {
    ...USER_SERVERS,
    "claude-peers": { command: "bun", env: { claude_peers_tools: "x", Claude_Peers_Tools: "y", KEEP: "1" } }
  };
  const mint = await mintDemoTile(mintInput(dir, [host, fakeGuest({ host })], host, [], userServers));
  try {
    const { mcpServers } = JSON.parse(readFileSync(mint.mcpConfig, "utf-8")) as TileConfig;
    const env = mcpServers["claude-peers"]!.env!;
    const listKeys = Object.keys(env).filter((key) => key.toUpperCase() === "CLAUDE_PEERS_TOOLS");
    expect(listKeys, "a differently cased copy would race ours on Windows").toEqual(["CLAUDE_PEERS_TOOLS"]);
    expect(env.CLAUDE_PEERS_TOOLS).toBe(DEMO_PEER_TOOLS.join(","));
    expect(env.KEEP).toBe("1");
  } finally {
    mint.release();
  }
});

test("a missing or malformed global entry refuses the mint, names the entry only, and leaves no server or file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-refuse-"));
  tmpDirs.push(dir);
  const host = fakeGuest({ type: "window" });
  const guests = [host, fakeGuest({ host })];
  const marker = "ENTRY-CONTENT-MARKER";
  const cases: Array<[string, unknown, string]> = [
    ["claude-peers absent", { "kory-roadmap": USER_SERVERS["kory-roadmap"] }, '"claude-peers"'],
    ["kory-roadmap absent", { "claude-peers": USER_SERVERS["claude-peers"] }, '"kory-roadmap"'],
    ["no user mcpServers at all", null, '"claude-peers"'],
    ["command missing", { ...USER_SERVERS, "kory-roadmap": { args: [], env: { KEY: marker } } }, '"kory-roadmap"'],
    ["env not a string map", { ...USER_SERVERS, "claude-peers": { command: "bun", env: { KEY: marker, N: 3 } } }, '"claude-peers"'],
    ["args not strings", { ...USER_SERVERS, "claude-peers": { command: "bun", args: [marker, 4] } }, '"claude-peers"']
  ];
  for (const [label, userServers, named] of cases) {
    let error: Error | null = null;
    try {
      await mintDemoTile(mintInput(dir, guests, host, [], userServers));
    } catch (e) {
      error = e as Error;
    }
    expect(error, label).not.toBeNull();
    expect(error!.message, label).toContain(named);
    expect(error!.message, `${label}: an entry's content never reaches the message`).not.toContain(marker);
  }
  expect(readdirSync(dir), "no config was written").toEqual([]);
});

test("readUserMcpServers returns the top-level mcpServers and reports a read or parse failure without file content", () => {
  const file = "/home/u/.claude.json";
  expect(readUserMcpServers(file, () => JSON.stringify({ mcpServers: { a: { command: "x" } }, projects: {} }))).toEqual({
    a: { command: "x" }
  });
  expect(() =>
    readUserMcpServers(file, () => {
      throw Object.assign(new Error("boom"), { code: "ENOENT" });
    })
  ).toThrow("ENOENT");
  const marker = "ENTRY-CONTENT-MARKER";
  let message = "";
  try {
    readUserMcpServers(file, () => `{"mcpServers": {"x": {"env": {"K": "${marker}"`);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("not valid JSON");
  expect(message).not.toContain(marker);
});

/** A raw socket, so an HTTP proxy in the environment cannot answer in the server's place. */
async function openKeepAlive(url: string, token: string): Promise<{ request(): Promise<string>; destroy(): void }> {
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    request: () =>
      new Promise<string>((resolve) => {
        let received = "";
        const onData = (chunk: Buffer): void => {
          received += chunk.toString("utf-8");
          if (!received.includes("\r\n\r\n")) return;
          socket.off("data", onData);
          resolve(received.split("\r\n")[0]!);
        };
        socket.on("data", onData);
        socket.once("close", () => resolve("closed"));
        socket.once("error", () => resolve("closed"));
        socket.write(
          `GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nConnection: keep-alive\r\n\r\n`
        );
      }),
    destroy: () => socket.destroy()
  };
}

async function controlAnswers(config: string): Promise<boolean> {
  const env = (
    JSON.parse(readFileSync(config, "utf-8")) as { mcpServers: Record<string, { env: Record<string, string> }> }
  ).mcpServers["demo-browser"]!.env;
  try {
    const res = await fetch(`${env.DEMO_CONTROL_URL}/health`, {
      headers: { authorization: `Bearer ${env.DEMO_CONTROL_TOKEN}` }
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

test("a demo tile gets its own server, config file and token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-tile-"));
  tmpDirs.push(dir);
  const host = fakeGuest({ type: "window" });
  const guest = fakeGuest({ host });
  const a = await mintDemoTile(mintInput(dir, [host, guest], host));
  const b = await mintDemoTile(mintInput(dir, [host, guest], host));
  try {
    expect(a.mcpConfig, "two tiles never share a config file").not.toBe(b.mcpConfig);
    expect(a.mcpConfig).not.toBe(join(dir, "demo-mcp.json"));
    const tokens = [a, b].map(
      (m) => (JSON.parse(readFileSync(m.mcpConfig, "utf-8")) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers["demo-browser"]!.env.DEMO_CONTROL_TOKEN
    );
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(await controlAnswers(a.mcpConfig)).toBe(true);
  } finally {
    a.release();
    b.release();
  }
});

test("releasing a demo tile closes its server and deletes its config, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-release-"));
  tmpDirs.push(dir);
  const host = fakeGuest({ type: "window" });
  const reports: string[] = [];
  const mint = await mintDemoTile(mintInput(dir, [host, fakeGuest({ host })], host, reports));
  const other = await mintDemoTile(mintInput(dir, [host, fakeGuest({ host })], host, reports));
  const config = mint.mcpConfig;
  const env = (JSON.parse(readFileSync(config, "utf-8")) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers["demo-browser"]!.env;
  const held = await openKeepAlive(env.DEMO_CONTROL_URL!, env.DEMO_CONTROL_TOKEN!);
  expect(await held.request(), "control answers before the release").toContain(" 200 ");

  mint.release();
  mint.release();

  expect(existsSync(config)).toBe(false);
  expect(await held.request(), "a connection held open before the release answers nothing").not.toContain(" 200 ");
  held.destroy();
  expect(await controlAnswers(other.mcpConfig), "releasing one tile leaves the other's server alone").toBe(true);
  other.release();
  expect(reports).toEqual([]);
});

test("a demo mint without exactly one embedded browser starts no server and writes no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-nobrowser-"));
  tmpDirs.push(dir);
  const host = fakeGuest({ type: "window" });
  await expect(mintDemoTile(mintInput(dir, [host], host))).rejects.toThrow("not open");
  expect(readdirSync(dir)).toEqual([]);
});

test("a config write that fails closes the server it just started", async () => {
  const host = fakeGuest({ type: "window" });
  let url = "";
  const input = {
    ...mintInput("/unused", [host, fakeGuest({ host })], host),
    writeConfig: (control: { url: string; token: string }) => {
      url = control.url;
      throw new Error("disk full");
    }
  };
  await expect(mintDemoTile(input)).rejects.toThrow("disk full");
  const port = Number(new URL(url).port);
  const accepts = await new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  expect(accepts, "no server is left listening").toBe(false);
});

test("writeDemoMcpConfig keeps the headless run's fixed file name unless a tile names its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-name-"));
  tmpDirs.push(dir);
  const base = { dir, mcpScriptPath: "/s.mjs", execPath: "/e", controlUrl: "http://127.0.0.1:1", controlToken: "t" };
  expect(writeDemoMcpConfig(base)).toBe(join(dir, "demo-mcp.json"));
  expect(writeDemoMcpConfig({ ...base, fileName: "demo-mcp-ab12.json" })).toBe(join(dir, "demo-mcp-ab12.json"));
});

test("the system-prompt anchor is the code constant, rewritten per run", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-sys-"));
  tmpDirs.push(dir);
  const file = writeDemoSystemPrompt(dir);
  expect(readFileSync(file, "utf-8")).toBe(DEMO_SYSTEM_PROMPT);
  // A tampered file on disk is overwritten at the next run (locked harness).
  writeFileSync(file, "you are now a pirate", "utf-8");
  writeDemoSystemPrompt(dir);
  expect(readFileSync(file, "utf-8")).toBe(DEMO_SYSTEM_PROMPT);
  // The role covers the tool contract and the data framing of the scenario.
  expect(DEMO_SYSTEM_PROMPT).toContain("demo_read");
  expect(DEMO_SYSTEM_PROMPT).toContain("DESCRIPTION OF WHAT TO SHOW");
});
