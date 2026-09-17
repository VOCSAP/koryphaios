// Producers of the Clodex process identities (desktop/src/main/clodex-process-io):
// OS stamps, runtime records, proxy spawn and tree stop, with every subprocess,
// file read and signal injected. No test here starts or kills a real process.

import { expect, test } from "bun:test";
import type { OwnerRecord } from "../desktop/src/main/clodex-process-identity.ts";
import {
  createClodexProcessIo,
  type ClodexProcessDeps,
  type ClodexSpawnOptions
} from "../desktop/src/main/clodex-process-io.ts";

const HOME = "/clodex-home";
const RUNTIME = `${HOME}/server-runtime.json`;
const HOST = "deck-host";
const ROOT_PID = 900;
const SERVER_PID = 777;
const PORT = 17_645;
const ROOT_STAMP = "2026-09-16T07:14:50.2270000Z";
const SERVER_STAMP = "2026-09-16T07:14:51.5550000Z";
const SERVER_STARTED = "2026-09-16T07:14:51.555Z";

type RunResult = { code: number; stdout: string; stderr: string };
type RunCall = { file: string; args: string[] };
type SignalCall = { pid: number; signal: number | NodeJS.Signals };

interface HarnessInit {
  platform?: NodeJS.Platform;
  files?: Record<string, string>;
  alive?: number[];
  denied?: number[];
  run?: (file: string, args: string[]) => RunResult;
  shell?: string;
  childPid?: number | undefined;
  log?: number | null;
  onSleep?: (files: Map<string, string>, alive: Set<number>) => void;
}

function record(
  pid: number,
  port: number,
  startedAt: string,
  mode = "proxy"
): Record<string, unknown> {
  return { mode, port, pid, caPath: "C:/clodex/ca.pem", startedAt };
}

function procStat(pid: number, pgrp: number, startToken: string): string {
  const tail = ["S", "1", String(pgrp), "900", "0", "-1", "4194304", "100", "0", "0", "0", "5", "5"];
  return `${pid} (node (proxy) ${tail.join(" ")} 0 0 20 0 1 0 ${startToken} 7 8 9\n`;
}

function windowsStamps(stamps: Record<number, string>): (file: string, args: string[]) => RunResult {
  return (file, args) => {
    if (file !== "powershell.exe") return { code: 0, stdout: "", stderr: "" };
    const pid = Number(/-Id (\d+)/.exec(args[3] ?? "")?.[1]);
    const stamp = stamps[pid];
    return stamp
      ? { code: 0, stdout: `${stamp}\r\n`, stderr: "" }
      : { code: 1, stdout: "", stderr: `no process with id ${pid}` };
  };
}

function harness(init: HarnessInit = {}) {
  const files = new Map(Object.entries(init.files ?? {}));
  const alive = new Set(init.alive ?? []);
  const denied = new Set(init.denied ?? []);
  const runs: RunCall[] = [];
  const spawns: Array<{ file: string; args: string[]; options: ClodexSpawnOptions }> = [];
  const signals: SignalCall[] = [];
  const traces: Array<{ message: string; error?: unknown }> = [];
  let endChild: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    endChild = resolve;
  });
  let unrefs = 0;
  let sleeps = 0;

  const deps: ClodexProcessDeps = {
    platform: init.platform ?? "win32",
    hostname: () => HOST,
    env: init.shell === undefined ? { CLODEX_HOME: HOME } : { CLODEX_HOME: HOME, SHELL: init.shell },
    sleep: async () => {
      sleeps++;
      init.onSleep?.(files, alive);
    },
    run: async (file, args) => {
      runs.push({ file, args });
      return init.run?.(file, args) ?? { code: 0, stdout: "", stderr: "" };
    },
    readFile: (path) => files.get(path) ?? null,
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal !== 0) return;
      const failure = new Error(`kill ${pid}`) as NodeJS.ErrnoException;
      if (denied.has(pid)) {
        failure.code = "EPERM";
        throw failure;
      }
      if (!alive.has(pid)) {
        failure.code = "ESRCH";
        throw failure;
      }
    },
    spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      return {
        pid: "childPid" in init ? init.childPid : ROOT_PID,
        exited,
        unref: () => {
          unrefs++;
        }
      };
    },
    openLog: () => init.log ?? null,
    onError: (_scope, message, error) => {
      traces.push({ message, error });
    }
  };

  return {
    io: createClodexProcessIo(deps, {
      registerAttempts: 3,
      registerIntervalMs: 1,
      stopAttempts: 3,
      stopIntervalMs: 1
    }),
    alive,
    files,
    runs,
    spawns,
    signals,
    traces,
    endChild: () => endChild(),
    unrefs: () => unrefs,
    sleeps: () => sleeps
  };
}

const winOwner = (over: Partial<{ rootStamp: string; serverStamp: string; rootPid: number }> = {}): OwnerRecord => ({
  server: { host: HOST, pid: SERVER_PID, startedAt: Date.parse(SERVER_STARTED), port: PORT },
  tree: {
    platform: "win32",
    root: { pid: over.rootPid ?? ROOT_PID, creationUtc: over.rootStamp ?? ROOT_STAMP },
    runtime: { pid: SERVER_PID, creationUtc: over.serverStamp ?? SERVER_STAMP }
  }
});

const posixOwner = (over: Partial<{ rootToken: string; pgid: number }> = {}): OwnerRecord => ({
  server: { host: HOST, pid: SERVER_PID, startedAt: Date.parse(SERVER_STARTED), port: PORT },
  tree: {
    platform: "linux",
    root: { pid: ROOT_PID, startToken: over.rootToken ?? "4455667" },
    runtime: { pid: SERVER_PID, startToken: "4455999" },
    pgid: over.pgid ?? ROOT_PID
  }
});

test("stampWin32 asks one source and keeps its seven fraction digits verbatim", async () => {
  const h = harness({ run: windowsStamps({ [ROOT_PID]: ROOT_STAMP }) });
  const stamp = await h.io.stampWin32(ROOT_PID);
  expect(stamp).toEqual({ pid: ROOT_PID, creationUtc: ROOT_STAMP });
  expect(h.runs[0]).toEqual({
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${ROOT_PID}).StartTime.ToUniversalTime().ToString('o')`
    ]
  });
});

test("stampWin32 refuses an unmeasurable pid instead of guessing a stamp", async () => {
  const h = harness({ run: windowsStamps({}) });
  await expect(h.io.stampWin32(ROOT_PID)).rejects.toThrow(/Cannot measure the creation time/);
});

test("stampWin32 refuses output that is not exactly a stamp", async () => {
  const h = harness({ run: () => ({ code: 0, stdout: `error\n${ROOT_STAMP}\n`, stderr: "" }) });
  await expect(h.io.stampWin32(ROOT_PID)).rejects.toThrow(/Cannot measure the creation time/);
});

test("stampWin32 rejects a pid that is not a positive integer", async () => {
  const h = harness();
  await expect(h.io.stampWin32(Number.NaN)).rejects.toThrow(TypeError);
  expect(h.runs).toHaveLength(0);
});

test("stampPosix reads the group and start time around a comm holding spaces and a paren", async () => {
  const h = harness({
    platform: "linux",
    files: { [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, ROOT_PID, "4455667") }
  });
  expect(await h.io.stampPosix(ROOT_PID)).toEqual({ pid: ROOT_PID, startToken: "4455667", pgid: ROOT_PID });
});

test("stampPosix refuses a stat line whose fields are not measurable", async () => {
  const h = harness({ platform: "linux", files: { [`/proc/${ROOT_PID}/stat`]: `${ROOT_PID} (node) S 1\n` } });
  await expect(h.io.stampPosix(ROOT_PID)).rejects.toThrow(/unexpected stat fields/);
});

test("isAlive answers dead only on ESRCH, and traces an undecided probe as alive", async () => {
  const h = harness({ alive: [ROOT_PID], denied: [SERVER_PID] });
  expect(await h.io.isAlive({ host: HOST, pid: ROOT_PID, startedAt: 10 })).toBe(true);
  expect(await h.io.isAlive({ host: HOST, pid: 42, startedAt: 10 })).toBe(false);
  expect(await h.io.isAlive({ host: HOST, pid: SERVER_PID, startedAt: 10 })).toBe(true);
  expect(h.traces.map((t) => t.message)).toEqual([`liveness probe of pid ${SERVER_PID} was inconclusive`]);
});

test("isAlive never probes a pid belonging to another host", async () => {
  const h = harness({ alive: [] });
  expect(await h.io.isAlive({ host: "other-host", pid: ROOT_PID, startedAt: 10 })).toBe(true);
  expect(h.signals).toHaveLength(0);
});

test("readServer prefers a live proxy over a more recent plain server", async () => {
  const h = harness({
    alive: [SERVER_PID, 555],
    files: {
      [RUNTIME]: JSON.stringify([
        record(SERVER_PID, PORT, SERVER_STARTED),
        record(555, 8080, "2026-09-16T09:00:00.000Z", "plain")
      ])
    }
  });
  expect(await h.io.readServer()).toEqual({
    host: HOST,
    pid: SERVER_PID,
    startedAt: Date.parse(SERVER_STARTED),
    port: PORT
  });
});

test("readServer keeps the most recent live proxy and skips the dead one", async () => {
  const h = harness({
    alive: [SERVER_PID],
    files: {
      [RUNTIME]: JSON.stringify([
        record(SERVER_PID, PORT, SERVER_STARTED),
        record(555, 8080, "2026-09-16T09:00:00.000Z")
      ])
    }
  });
  expect((await h.io.readServer())?.pid).toBe(SERVER_PID);
});

test("readServer drops records with an impossible day or an out-of-range port, and traces them", async () => {
  const h = harness({
    alive: [SERVER_PID, 555, 556],
    files: {
      [RUNTIME]: JSON.stringify([
        record(555, PORT, "2026-02-30T07:14:51.555Z"),
        record(556, 65_536, "2026-09-16T09:00:00.000Z"),
        record(SERVER_PID, PORT, SERVER_STARTED)
      ])
    }
  });
  expect((await h.io.readServer())?.pid).toBe(SERVER_PID);
  expect(h.traces.map((t) => t.message)).toEqual(["ignored 2 unusable record(s) in server-runtime.json"]);
});

test("readServer answers null when clodex wrote no manifest", async () => {
  expect(await harness().io.readServer()).toBeNull();
});

test("readServer refuses a manifest that is not an array", async () => {
  const h = harness({ files: { [RUNTIME]: JSON.stringify({ pid: SERVER_PID }) } });
  await expect(h.io.readServer()).rejects.toThrow(/not a JSON array/);
});

test("measureServer answers the record of that exact pid", async () => {
  const h = harness({ files: { [RUNTIME]: JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]) } });
  expect(await h.io.measureServer(SERVER_PID)).toEqual({
    host: HOST,
    pid: SERVER_PID,
    startedAt: Date.parse(SERVER_STARTED),
    port: PORT
  });
  expect(await h.io.measureServer(555)).toBeNull();
});

test("measureServer refuses two records naming the same pid", async () => {
  const h = harness({
    files: {
      [RUNTIME]: JSON.stringify([
        record(SERVER_PID, PORT, SERVER_STARTED),
        record(SERVER_PID, 8080, "2026-09-16T09:00:00.000Z")
      ])
    }
  });
  expect(await h.io.measureServer(SERVER_PID)).toBeNull();
});

test("spawn owns the shell root and the registered server as two distinct processes", async () => {
  const h = harness({
    log: 7,
    files: { [RUNTIME]: JSON.stringify([record(100, 9000, "2026-09-15T07:00:00.000Z")]) },
    run: windowsStamps({ [ROOT_PID]: ROOT_STAMP, [SERVER_PID]: SERVER_STAMP }),
    onSleep: (files) =>
      files.set(
        RUNTIME,
        JSON.stringify([record(100, 9000, "2026-09-15T07:00:00.000Z"), record(SERVER_PID, PORT, SERVER_STARTED)])
      )
  });
  const owner = await h.io.spawn("clodex", ["server", "--proxy"]);
  expect(owner).toEqual(winOwner());
  expect(h.spawns[0]).toEqual({
    file: "cmd.exe",
    args: ["/d", "/s", "/c", "clodex server --proxy"],
    options: { detached: true, windowsHide: true, stdio: ["ignore", 7, 7] }
  });
  expect(h.unrefs()).toBe(1);
});

test("no detached win32 spawn goes through PowerShell, which exits without running its command", async () => {
  for (const shell of [undefined, "", "powershell.exe", "pwsh.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"]) {
    const h = harness({ shell });
    await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow();
    expect(h.spawns).toHaveLength(1);
    const spawned = h.spawns[0]!;
    const binary = spawned.file.split(/[\\/]/).pop()!.toLowerCase();
    expect(
      spawned.options.detached && /^(powershell|pwsh)(\.exe)?$/.test(binary),
      `SHELL=${String(shell)} spawned ${spawned.file} detached`
    ).toBe(false);
  }
});

test("spawn on posix proves the root leads its own group", async () => {
  const h = harness({
    platform: "linux",
    files: {
      [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, ROOT_PID, "4455667"),
      [`/proc/${SERVER_PID}/stat`]: procStat(SERVER_PID, ROOT_PID, "4455999")
    },
    onSleep: (files) => files.set(RUNTIME, JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]))
  });
  const owner = await h.io.spawn("clodex", ["server", "--proxy"]);
  expect(owner).toEqual(posixOwner());
  expect(h.spawns[0]?.file).toBe("/bin/bash");
  expect(h.spawns[0]?.args).toEqual(["-l", "-c", "clodex server --proxy"]);
  expect(h.spawns[0]?.options.detached).toBe(true);
});

test("spawn launches the shell named by the injected environment", async () => {
  const h = harness({ platform: "linux", shell: "/usr/bin/zsh" });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow();
  expect(h.spawns[0]?.file).toBe("/usr/bin/zsh");
});

test("spawn refuses a proxy registered outside the owned group", async () => {
  const h = harness({
    platform: "linux",
    files: {
      [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, ROOT_PID, "4455667"),
      [`/proc/${SERVER_PID}/stat`]: procStat(SERVER_PID, 12, "4455999")
    },
    onSleep: (files) => files.set(RUNTIME, JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]))
  });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(
    new RegExp(`runs in group 12, outside the owned ${ROOT_PID}`)
  );
});

test("spawn refuses a root that does not lead its group", async () => {
  const h = harness({
    platform: "linux",
    files: {
      [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, 12, "4455667"),
      [`/proc/${SERVER_PID}/stat`]: procStat(SERVER_PID, 12, "4455999")
    },
    onSleep: (files) => files.set(RUNTIME, JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]))
  });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/does not lead its process group/);
});

test("spawn reports a server that left before registering", async () => {
  const h = harness({ run: windowsStamps({}) });
  h.endChild();
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/exited before registering/);
});

test("spawn refuses to own one of two proxies that appeared at once", async () => {
  const h = harness({
    onSleep: (files) =>
      files.set(
        RUNTIME,
        JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED), record(778, 17_646, "2026-09-16T07:14:52.000Z")])
      )
  });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(
    new RegExp(`none can be owned; pid ${ROOT_PID} was left running`)
  );
});

test("spawn names the pid it leaves running when no proxy registers in time", async () => {
  const h = harness();
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(
    new RegExp(`did not register a proxy in time; pid ${ROOT_PID} was left running`)
  );
});

test("spawn names the pid it leaves running when the owner cannot be measured", async () => {
  const h = harness({
    run: windowsStamps({}),
    onSleep: (files) => files.set(RUNTIME, JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]))
  });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(
    new RegExp(`Cannot measure the creation time of pid .*; pid ${ROOT_PID} was left running`)
  );
});

test("spawn refuses a command token that is not a plain word", async () => {
  const h = harness();
  await expect(h.io.spawn("clodex", ["server; rm -rf /"])).rejects.toThrow(TypeError);
  expect(h.spawns).toHaveLength(0);
});

test("spawn refuses a child without a process id", async () => {
  const h = harness({ childPid: undefined });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(TypeError);
});

test("stopTree kills the whole tree once the root stamp is proven", async () => {
  const stamp = windowsStamps({ [ROOT_PID]: ROOT_STAMP });
  const h: ReturnType<typeof harness> = harness({
    alive: [ROOT_PID, SERVER_PID],
    run: (file, args) => {
      if (file !== "taskkill") return stamp(file, args);
      h.alive.delete(ROOT_PID);
      h.alive.delete(SERVER_PID);
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  await h.io.stopTree(winOwner());
  expect(h.runs.filter((call) => call.file === "taskkill")).toEqual([
    { file: "taskkill", args: ["/T", "/F", "/PID", String(ROOT_PID)] }
  ]);
  expect(h.sleeps()).toBe(0);
});

test("stopTree reports a proxy that survived a taskkill which exited zero", async () => {
  const h = harness({ alive: [ROOT_PID, SERVER_PID], run: windowsStamps({ [ROOT_PID]: ROOT_STAMP }) });
  await expect(h.io.stopTree(winOwner())).rejects.toThrow(
    new RegExp(`survived the stop; pid ${SERVER_PID} is still running`)
  );
});

test("stopTree waits for a group that leaves on its own signal", async () => {
  const h = harness({
    platform: "linux",
    alive: [ROOT_PID, SERVER_PID],
    files: { [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, ROOT_PID, "4455667") },
    onSleep: (_files, alive) => {
      alive.delete(ROOT_PID);
      alive.delete(SERVER_PID);
    }
  });
  await h.io.stopTree(posixOwner());
  expect(h.sleeps()).toBe(1);
});

test("stopTree refuses to kill when the root stamp differs by its last digit", async () => {
  const h = harness({
    alive: [ROOT_PID, SERVER_PID],
    run: windowsStamps({ [ROOT_PID]: "2026-09-16T07:14:50.2270001Z" })
  });
  await expect(h.io.stopTree(winOwner())).rejects.toThrow(/Refusing to stop pid/);
  expect(h.runs.filter((call) => call.file === "taskkill")).toHaveLength(0);
});

test("stopTree refuses to kill when the root can no longer be measured", async () => {
  const h = harness({ alive: [ROOT_PID, SERVER_PID], run: windowsStamps({}) });
  await expect(h.io.stopTree(winOwner())).rejects.toThrow(/Cannot measure the creation time/);
  expect(h.runs.filter((call) => call.file === "taskkill")).toHaveLength(0);
});

test("stopTree refuses an owner minted on another platform", async () => {
  const h = harness({ platform: "linux", alive: [ROOT_PID, SERVER_PID] });
  await expect(h.io.stopTree(winOwner())).rejects.toThrow(/Refusing to stop a win32 clodex tree from linux/);
  expect(h.runs).toHaveLength(0);
});

test("stopTree refuses an owner record that no longer parses", async () => {
  const h = harness({ alive: [ROOT_PID] });
  const broken = { ...winOwner(), server: { ...winOwner().server, port: 65_536 } } as OwnerRecord;
  await expect(h.io.stopTree(broken)).rejects.toThrow(TypeError);
  expect(h.runs).toHaveLength(0);
});

test("stopTree kills nothing when the root is gone, and reports a proxy that outlived it", async () => {
  const h = harness({ alive: [SERVER_PID] });
  await h.io.stopTree(winOwner());
  expect(h.runs).toHaveLength(0);
  expect(h.traces.map((t) => t.message)).toEqual([
    `clodex proxy pid ${SERVER_PID} outlived its launcher ${ROOT_PID} and was left running`
  ]);
});

test("stopTree stays silent when the whole tree is already gone", async () => {
  const h = harness({ alive: [] });
  await h.io.stopTree(winOwner());
  expect(h.runs).toHaveLength(0);
  expect(h.traces).toHaveLength(0);
});

test("stopTree reports a taskkill that did not stop the tree", async () => {
  const h = harness({
    alive: [ROOT_PID, SERVER_PID],
    run: (file, args) =>
      file === "taskkill"
        ? { code: 128, stdout: "", stderr: "process not found" }
        : windowsStamps({ [ROOT_PID]: ROOT_STAMP })(file, args)
  });
  await expect(h.io.stopTree(winOwner())).rejects.toThrow(/exit 128/);
});

test("stopTree signals the proven group on posix", async () => {
  const h = harness({
    platform: "linux",
    alive: [ROOT_PID, SERVER_PID],
    files: { [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, ROOT_PID, "4455667") },
    onSleep: (_files, alive) => {
      alive.delete(ROOT_PID);
      alive.delete(SERVER_PID);
    }
  });
  await h.io.stopTree(posixOwner());
  expect(h.signals.filter((call) => call.signal !== 0)).toEqual([{ pid: -ROOT_PID, signal: "SIGTERM" }]);
});

test("stopTree refuses a posix group the owned root no longer leads", async () => {
  const h = harness({
    platform: "linux",
    alive: [ROOT_PID, SERVER_PID],
    files: { [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, 555, "4455667") }
  });
  await expect(h.io.stopTree(posixOwner())).rejects.toThrow(/does not lead it/);
  expect(h.signals.filter((call) => call.signal !== 0)).toHaveLength(0);
});

test("stopTree refuses a posix root whose start token moved", async () => {
  const h = harness({
    platform: "linux",
    alive: [ROOT_PID, SERVER_PID],
    files: { [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, ROOT_PID, "4455668") }
  });
  await expect(h.io.stopTree(posixOwner())).rejects.toThrow(/it was started at 4455668/);
  expect(h.signals.filter((call) => call.signal !== 0)).toHaveLength(0);
});

test("stopTree reports the proxy that a taskkill left re-parented", async () => {
  const stamp = windowsStamps({ [ROOT_PID]: ROOT_STAMP });
  const h: ReturnType<typeof harness> = harness({
    alive: [ROOT_PID, SERVER_PID],
    run: (file, args) => {
      if (file !== "taskkill") return stamp(file, args);
      h.alive.delete(ROOT_PID);
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  await expect(h.io.stopTree(winOwner())).rejects.toThrow(
    new RegExp(`survived the stop; pid ${SERVER_PID} is still running`)
  );
});

test("stopTree traces an undecided liveness probe once per stop", async () => {
  const h = harness({
    alive: [ROOT_PID],
    denied: [SERVER_PID],
    run: windowsStamps({ [ROOT_PID]: ROOT_STAMP })
  });
  await expect(h.io.stopTree(winOwner())).rejects.toThrow(/survived the stop/);
  expect(h.traces).toHaveLength(1);
  expect(h.sleeps()).toBe(3);
});
