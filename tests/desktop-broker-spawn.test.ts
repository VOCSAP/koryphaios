// The Deck starting the loopback broker itself (desktop/src/main/broker-spawn.ts):
// where the script comes from (global config only), when a spawn happens, and
// how often a dead broker is relaunched.

import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import {
  ensureLoopbackBroker,
  locateBrokerScript,
  locateUserBrokerScript,
  RespawnThrottle,
  spawnDetachedBroker,
  withPathEntry,
  type EnsureDeps,
} from "../desktop/src/main/broker-spawn";

const CLAUDE_JSON = "/home/op/.claude.json";
const APP_ROOT = "/opt/koryphaios/desktop";

type DetachedSpawnOptions = {
  detached: true;
  stdio: "ignore";
  env: Record<string, string | undefined>;
};

function locateDeps(files: Record<string, string>, existing: string[]) {
  const reads: string[] = [];
  const warnings: string[] = [];
  return {
    reads,
    warnings,
    deps: {
      readFile: (p: string) => {
        reads.push(p);
        return files[p] ?? null;
      },
      exists: (p: string) => existing.includes(p),
      homeDir: "/home/op",
      warn: (m: string) => warnings.push(m),
    },
  };
}

test("the script is the sibling of the server.ts named by the user-scope claude.json entry", () => {
  const { deps, reads } = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "/usr/local/bin/bun", args: ["/home/op/koryphaios/server.ts"] } } }) },
    ["/home/op/koryphaios/broker.ts"]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, deps), "the global MCP entry decides the script and the executable").toEqual({
    script: "/home/op/koryphaios/broker.ts",
    command: "/usr/local/bin/bun",
    env: {},
    source: "claude-json",
  });
  expect(reads, "only the user-scope claude.json is ever read, never a project .mcp.json").toEqual([CLAUDE_JSON]);
});

test("a hand-written tilde path is expanded against the operator's home", () => {
  const { deps } = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "bun", args: ["~/koryphaios/server.ts"] } } }) },
    ["/home/op/koryphaios/broker.ts"]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, deps)?.script, "a tilde no filesystem call expands must be resolved before the existence check").toBe(
    "/home/op/koryphaios/broker.ts"
  );
});

test("a Windows-style server.ts path resolves to its sibling too", () => {
  const { deps } = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "bun", args: ["C:\\Users\\op\\koryphaios\\server.ts"] } } }) },
    ["C:\\Users\\op\\koryphaios\\broker.ts"]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, deps)?.script, "a backslash path keeps its separators and swaps the file name").toBe(
    "C:\\Users\\op\\koryphaios\\broker.ts"
  );
});

test("without a usable entry the repository the Deck lives in is tried, then nothing", () => {
  const sibling = resolve(APP_ROOT, "..", "broker.ts");
  const noEntry = locateDeps({ [CLAUDE_JSON]: JSON.stringify({ mcpServers: {} }) }, [sibling]);
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, noEntry.deps), "the Deck's own repository is the fallback").toEqual({
    script: sibling,
    command: "bun",
    env: {},
    source: "app-root",
  });
  const nothing = locateDeps({}, []);
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, nothing.deps), "no script anywhere is an explicit null, not a guess").toBeNull();
});

test("an entry whose server.ts sibling does not exist is not trusted, and invalid JSON is traced then bypassed", () => {
  const sibling = resolve(APP_ROOT, "..", "broker.ts");
  const missing = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "bun", args: ["/gone/server.ts"] } } }) },
    [sibling]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, missing.deps)?.source, "a stale entry falls through to the repository").toBe("app-root");
  const invalid = locateDeps({ [CLAUDE_JSON]: "{ not json" }, [sibling]);
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, invalid.deps)?.source, "invalid JSON still reaches the fallback").toBe("app-root");
  expect(invalid.warnings.length, "the unreadable claude.json is traced, never swallowed").toBe(1);
});

function ensureDeps(overrides: Partial<EnsureDeps> & { aliveAfterPolls?: number }) {
  const spawned: string[] = [];
  let polls = 0;
  const aliveAfter = overrides.aliveAfterPolls ?? Number.POSITIVE_INFINITY;
  const deps: EnsureDeps = {
    isAlive: async () => {
      polls += 1;
      return polls > aliveAfter;
    },
    stopped: () => false,
    locate: () => ({ script: "/x/broker.ts", command: "bun", env: {}, source: "claude-json" }),
    spawn: (command, script, env) => {
      spawned.push(`${command} ${script}${Object.keys(env).length ? ` ${JSON.stringify(env)}` : ""}`);
    },
    sleep: async () => {},
    attempts: 3,
    pollMs: 1,
    ...overrides,
  };
  return { deps, spawned, polls: () => polls };
}

test("remote mode never spawns nor even probes: a loopback process would not serve that URL", async () => {
  const { deps, spawned, polls } = ensureDeps({});
  expect(await ensureLoopbackBroker("remote", "http://broker.example:7899", deps)).toEqual({ action: "skipped", reason: "remote-mode" });
  expect([spawned, polls()], "nothing is spawned and nothing is probed in remote mode").toEqual([[], 0]);
});

test("an answering broker is left alone", async () => {
  const { deps, spawned } = ensureDeps({ aliveAfterPolls: 0 });
  expect(await ensureLoopbackBroker("local", "http://127.0.0.1:7899", deps)).toEqual({ action: "already-running" });
  expect(spawned, "no second broker is spawned next to a live one").toEqual([]);
});

test("a silent loopback is spawned from the located script and reported once /health answers", async () => {
  const { deps, spawned } = ensureDeps({ aliveAfterPolls: 2 });
  expect(await ensureLoopbackBroker("replica", "http://127.0.0.1:7899", deps)).toEqual({
    action: "started",
    script: "/x/broker.ts",
    source: "claude-json",
  });
  expect(spawned, "the MCP entry's executable runs the sibling broker.ts").toEqual(["bun /x/broker.ts"]);
});

test("no script, a spawn that throws, or a broker that never answers are three distinct explicit failures", async () => {
  const none = ensureDeps({ locate: () => null });
  expect(await ensureLoopbackBroker("local", "http://127.0.0.1:7899", none.deps)).toEqual({ action: "not-found" });
  const enoent = ensureDeps({ spawn: () => { throw new Error("spawn bun ENOENT"); } });
  expect(await ensureLoopbackBroker("local", "http://127.0.0.1:7899", enoent.deps)).toEqual({
    action: "failed",
    script: "/x/broker.ts",
    reason: "spawn bun ENOENT",
  });
  const mute = ensureDeps({});
  const outcome = await ensureLoopbackBroker("local", "http://127.0.0.1:7899", mute.deps);
  expect([outcome.action, mute.polls()], "the poll budget is spent then the failure is named").toEqual(["failed", 4]);
});

test("a manually stopped broker is never spawned, in local and replica modes", async () => {
  for (const mode of ["local", "replica"] as const) {
    let located = 0;
    const { deps, spawned } = ensureDeps({
      stopped: () => true,
      locate: () => {
        located += 1;
        return { script: "/x/broker.ts", command: "bun", env: {}, source: "claude-json" };
      },
    });
    expect(await ensureLoopbackBroker(mode, "http://127.0.0.1:7899", deps)).toEqual({ action: "skipped", reason: "manual-stop" });
    expect([spawned, located], "the stop marker is checked before anything is located or spawned").toEqual([[], 0]);
  }
});

test("an answering broker is left alone even while a stop marker exists", async () => {
  const { deps, spawned } = ensureDeps({ aliveAfterPolls: 0, stopped: () => true });
  expect(await ensureLoopbackBroker("local", "http://127.0.0.1:7899", deps)).toEqual({ action: "already-running" });
  expect(spawned).toEqual([]);
});

test("a respawn is allowed once per interval, never on every failing poll", () => {
  let clock = 0;
  const throttle = new RespawnThrottle(60_000, () => clock);
  expect(throttle.allow(), "the first outage may respawn").toBe(true);
  clock = 30_000;
  expect(throttle.allow(), "half an interval later is too soon").toBe(false);
  clock = 60_000;
  expect(throttle.allow(), "a full interval later may respawn again").toBe(true);
});

test("the real Windows entry of an operator is recognised, and only its CLAUDE_PEERS_ variables travel", () => {
  const { deps } = locateDeps(
    {
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: {
          "claude-peers": {
            command: "bun",
            args: ["C:\\Users\\Olivier\\workspace\\koryphaios-mcp\\server.ts"],
            env: { CLAUDE_PEERS_GROUP: "ovr-all", PATH: "C:\\evil", HOME: "C:\\elsewhere" },
            alwaysLoad: true,
          },
        },
      }),
    },
    ["C:\\Users\\Olivier\\workspace\\koryphaios-mcp\\broker.ts"]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, deps), "the entry's own env reaches the broker, minus anything outside the CLAUDE_PEERS_ namespace").toEqual({
    script: "C:\\Users\\Olivier\\workspace\\koryphaios-mcp\\broker.ts",
    command: "bun",
    env: { CLAUDE_PEERS_GROUP: "ovr-all" },
    source: "claude-json",
  });
});

test("the entry's variables are handed to the spawned broker", async () => {
  const { deps, spawned } = ensureDeps({
    aliveAfterPolls: 1,
    locate: () => ({ script: "/x/broker.ts", command: "bun", env: { CLAUDE_PEERS_GROUP: "ovr-all" }, source: "claude-json" }),
  });
  await ensureLoopbackBroker("local", "http://127.0.0.1:7899", deps);
  expect(spawned, "a Deck-spawned broker must see the same variables a session-spawned one inherits").toEqual([
    'bun /x/broker.ts {"CLAUDE_PEERS_GROUP":"ovr-all"}',
  ]);
});

test("the bun directory is appended to the PATH key that already exists, whatever its casing", () => {
  const windows = withPathEntry({ Path: "C:\\Windows", OTHER: "x" }, "C:\\Users\\Olivier\\.bun\\bin", ";");
  expect(Object.keys(windows).sort(), "a child must never receive both Path and PATH: which one wins is not ours to decide").toEqual([
    "OTHER",
    "Path",
  ]);
  expect(windows.Path, "the existing Windows value is kept and extended").toBe("C:\\Windows;C:\\Users\\Olivier\\.bun\\bin");
  const posix = withPathEntry({ PATH: "/usr/bin" }, "/home/op/.bun/bin", ":");
  expect(posix.PATH, "the posix key is extended the same way").toBe("/usr/bin:/home/op/.bun/bin");
  const empty = withPathEntry({}, "/home/op/.bun/bin", ":");
  expect(empty.PATH, "an environment with no PATH at all gets one, without a leading separator").toBe("/home/op/.bun/bin");
});

test("the user-scope helper locates the configured broker and returns null when no script exists", () => {
  const userConfig = join("/home/op", ".claude.json");
  const configured = locateDeps(
    { [userConfig]: JSON.stringify({ mcpServers: { "claude-peers": { command: "bun", args: ["/home/op/koryphaios/server.ts"] } } }) },
    ["/home/op/koryphaios/broker.ts"]
  );
  expect(locateUserBrokerScript(APP_ROOT, configured.deps)?.script).toBe("/home/op/koryphaios/broker.ts");
  const missing = locateDeps({}, []);
  expect(locateUserBrokerScript(APP_ROOT, missing.deps)).toBeNull();
  expect(missing.reads).toEqual([userConfig]);
});

test("the detached spawn adds bun to PATH, unreferences its child, and reports child errors", () => {
  let errorListener: ((error: unknown) => void) | undefined;
  let unrefCalls = 0;
  const calls: Array<[string, string[], DetachedSpawnOptions]> = [];
  const reports: Array<[string, unknown]> = [];
  spawnDetachedBroker("bun", "/opt/koryphaios/broker.ts", { CLAUDE_PEERS_GROUP: "local" }, {
    env: { PATH: "/usr/bin", CLAUDE_PEERS_GROUP: "deck" },
    homeDir: "/home/op",
    platform: "linux",
    spawn: (command: string, args: string[], options: DetachedSpawnOptions) => {
      calls.push([command, args, options]);
      return {
        on: (event: "error", listener: (error: unknown) => void) => {
          expect(event).toBe("error");
          errorListener = listener;
        },
        unref: () => {
          unrefCalls += 1;
        },
      };
    },
    report: (message: string, error: unknown) => reports.push([message, error]),
  });
  expect(calls).toEqual([[
    "bun",
    ["/opt/koryphaios/broker.ts"],
    { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/home/op/.bun/bin", CLAUDE_PEERS_GROUP: "local" } },
  ]]);
  expect(unrefCalls).toBe(1);
  const error = new Error("ENOENT");
  errorListener!(error);
  expect(reports).toEqual([["local broker process failed to start (bun /opt/koryphaios/broker.ts)", error]]);
});

test("on win32 the broker child is spawned detached so it outlives the Deck", () => {
  const spawned: DetachedSpawnOptions[] = [];
  spawnDetachedBroker("bun.exe", "C:\\repo\\broker.ts", {}, {
    env: { Path: "C:\\Windows" },
    homeDir: "C:\\Users\\op",
    platform: "win32",
    spawn: (_command: string, _args: string[], options: DetachedSpawnOptions) => {
      spawned.push(options);
      return { on: (_event: "error", _listener: (error: unknown) => void) => {}, unref: () => {} };
    },
    report: (_message: string, _error: unknown) => {},
  });
  expect(spawned).toHaveLength(1);
  expect(
    spawned[0]?.detached,
    "on win32 the broker must be detached: without it libuv's job object kills bun.exe when the Deck exits, and a detached bun.exe opens no console"
  ).toBe(true);
});

test("the detached spawn uses the Windows separator and preserves the Path key", () => {
  let environment: Record<string, string | undefined> | undefined;
  spawnDetachedBroker("bun.exe", "C:\\repo\\broker.ts", {}, {
    env: { Path: "C:\\Windows" },
    homeDir: "C:\\Users\\op",
    platform: "win32",
    spawn: (_command: string, _args: string[], options: DetachedSpawnOptions) => {
      environment = options.env;
      return { on: (_event: "error", _listener: (error: unknown) => void) => {}, unref: () => {} };
    },
    report: (_message: string, _error: unknown) => {},
  });
  expect(environment).toEqual({ Path: "C:\\Windows;C:\\Users\\op\\.bun\\bin" });
});
