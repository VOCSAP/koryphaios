// Producers of the Clodex process identities (desktop/src/main/clodex-process-io):
// OS stamps, runtime records, proxy spawn and tree stop, with every subprocess,
// file read and signal injected. No test here starts or kills a real process.

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { clodexHome } from "../desktop/src/main/clodex-bridge.ts";
import type { OwnerRecord } from "../desktop/src/main/clodex-process-identity.ts";
import {
  createClodexProcessIo,
  parseClodexProxyArgs,
  type ClodexProcessDeps,
  type ClodexSpawnOptions
} from "../desktop/src/main/clodex-process-io.ts";

const HOME = "C:\\clodex-home";
const RUNTIME = `${HOME}/server-runtime.json`;
const HOST = "deck-host";
const SYSTEM_ROOT = "C:\\Windows";
const CMD = "C:\\Windows\\System32\\cmd.exe";
const RELAY_PID = 950;
const CONHOST_PID = 951;
const ROOT_PID = 900;
const SERVER_PID = 777;
const PORT = 17_645;
const RELAY_STAMP = "2026-09-16T07:14:50.1000000Z";
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
  env?: NodeJS.ProcessEnv;
  /** CLODEX_HOME of the deps environment; null leaves it unset. */
  home?: string | null;
  makeDir?: (path: string) => void;
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

/** A Win32_Process row; `created` is the CIM clock, deliberately not the Get-Process one. */
interface CimRow {
  pid: number;
  parent: number;
  created: string;
  image: string;
}

const RELAY_ROW: CimRow = { pid: RELAY_PID, parent: 4, created: "2026-09-16T07:14:50.1000010Z", image: CMD };
const CONHOST_ROW: CimRow = {
  pid: CONHOST_PID,
  parent: RELAY_PID,
  created: "2026-09-16T07:14:50.1100000Z",
  image: "C:\\Windows\\System32\\conhost.exe"
};
const ROOT_ROW: CimRow = {
  pid: ROOT_PID,
  parent: RELAY_PID,
  created: "2026-09-16T07:14:50.2270010Z",
  image: "C:\\WINDOWS\\system32\\cmd.exe"
};
const TABLE: CimRow[] = [RELAY_ROW, CONHOST_ROW, ROOT_ROW];

interface WindowsWorld {
  /** Get-Process answers per pid; an array is consumed one answer per call. */
  stamps: Record<number, string | string[]>;
  /** Rows every CIM query filters. */
  table?: CimRow[];
  /** Replaces the answer of the n-th CIM query (0-based). */
  cim?: Record<number, RunResult | CimRow[]>;
  onCim?: (query: number) => void;
}

const cimOutput = (rows: CimRow[]): RunResult => ({
  code: 0,
  stdout: rows.map((row) => `${row.pid}|${row.parent}|${row.created}|${row.image}\r\n`).join(""),
  stderr: ""
});

function windowsStamps(
  stamps: WindowsWorld["stamps"],
  world: Omit<WindowsWorld, "stamps"> = {}
): (file: string, args: string[]) => RunResult {
  const table = world.table ?? TABLE;
  const served: Record<number, number> = {};
  let queries = 0;
  return (file, args) => {
    if (file !== "powershell.exe") return { code: 0, stdout: "", stderr: "" };
    const command = args[3] ?? "";
    const filter = /-Filter '([^']*)'/.exec(command)?.[1];
    if (filter !== undefined) {
      const query = queries++;
      world.onCim?.(query);
      const override = world.cim?.[query];
      if (override && !Array.isArray(override)) return override;
      const source = override ?? table;
      const both = /^ProcessId=(\d+) or ParentProcessId=(\d+)$/.exec(filter);
      const one = /^ProcessId=(\d+)$/.exec(filter);
      if (both) return cimOutput(source.filter((row) => row.pid === Number(both[1]) || row.parent === Number(both[2])));
      if (one) return cimOutput(source.filter((row) => row.pid === Number(one[1])));
      return { code: 1, stdout: "", stderr: `unexpected filter ${filter}` };
    }
    const pid = Number(/-Id (\d+)/.exec(command)?.[1]);
    const answer = stamps[pid];
    const index = served[pid] ?? 0;
    served[pid] = index + 1;
    const stamp = Array.isArray(answer) ? answer[Math.min(index, answer.length - 1)] : answer;
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
  const madeDirs: string[] = [];
  const home = init.home === undefined ? HOME : init.home;

  const deps: ClodexProcessDeps = {
    platform: init.platform ?? "win32",
    hostname: () => HOST,
    env: {
      ...(home === null ? {} : { CLODEX_HOME: home }),
      ...(init.shell === undefined ? {} : { SHELL: init.shell }),
      ...(init.env ?? { SystemRoot: SYSTEM_ROOT })
    },
    sleep: async () => {
      sleeps++;
      init.onSleep?.(files, alive);
    },
    run: async (file, args) => {
      runs.push({ file, args });
      return init.run?.(file, args) ?? { code: 0, stdout: "", stderr: "" };
    },
    readFile: (path) => files.get(path) ?? null,
    makeDir: (path) => {
      init.makeDir?.(path);
      madeDirs.push(path);
    },
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
        pid: "childPid" in init ? init.childPid : (init.platform ?? "win32") === "win32" ? RELAY_PID : ROOT_PID,
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
    madeDirs,
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

test("proxy arguments reject a value beyond the named length limit", () => {
  expect(() => parseClodexProxyArgs(`--providers=${"a".repeat(4096)}`)).toThrow("at most 4096 characters");
});

test("proxy arguments reject more than the named token limit", () => {
  expect(() => parseClodexProxyArgs(Array.from({ length: 65 }, () => "--ws-diagnostics").join(" "))).toThrow(
    "at most 64 tokens"
  );
});

test("proxy arguments accept the admitted diagnostics and discovery flags", () => {
  expect(parseClodexProxyArgs("--ws-diagnostics --no-discovery")).toEqual([
    "--ws-diagnostics",
    "--no-discovery"
  ]);
});

test("proxy arguments reject a structurally valid flag absent from the allow-list", () => {
  expect(() => parseClodexProxyArgs("--providers=openai")).toThrow(
    "accept only --ws-diagnostics and --no-discovery"
  );
});

test("proxy arguments reject a listening exposure by name", () => {
  expect(() => parseClodexProxyArgs("--listen=0.0.0.0")).toThrow(
    "accept only --ws-diagnostics and --no-discovery"
  );
});

test("proxy arguments reject a value on a flag the Clodex parser accepts only bare", () => {
  expect(() => parseClodexProxyArgs("--ws-diagnostics=verbose")).toThrow(
    "accept only --ws-diagnostics and --no-discovery"
  );
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

const registersServer = (files: Map<string, string>) =>
  files.set(RUNTIME, JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]));

const STAMPS = { [RELAY_PID]: RELAY_STAMP, [ROOT_PID]: ROOT_STAMP, [SERVER_PID]: SERVER_STAMP };

const cimFilters = (runs: RunCall[]) =>
  runs.map((call) => /-Filter '([^']*)'/.exec(call.args[3] ?? "")?.[1]).filter((filter) => filter !== undefined);

test("spawn owns the inner cmd.exe root and the registered server as two distinct processes", async () => {
  const h = harness({
    log: 7,
    files: { [RUNTIME]: JSON.stringify([record(100, 9000, "2026-09-15T07:00:00.000Z")]) },
    run: windowsStamps(STAMPS),
    onSleep: (files) =>
      files.set(
        RUNTIME,
        JSON.stringify([record(100, 9000, "2026-09-15T07:00:00.000Z"), record(SERVER_PID, PORT, SERVER_STARTED)])
      )
  });
  const owner = await h.io.spawn("clodex", ["server", "--proxy", "--ws-diagnostics", "--no-discovery"]);
  expect(owner, "the persisted root stamp is the Get-Process one").toEqual(winOwner());
  expect(h.spawns[0]).toEqual({
    file: CMD,
    args: [
      "/d",
      "/s",
      "/c",
      `${CMD} /d /s /c clodex server --proxy --ws-diagnostics --no-discovery`
    ],
    options: {
      detached: false,
      windowsHide: true,
      stdio: ["ignore", 7, 7],
      cwd: HOME,
      env: { CLODEX_HOME: HOME, SystemRoot: SYSTEM_ROOT, NoDefaultCurrentDirectoryInExePath: "1" }
    }
  });
  expect(h.unrefs()).toBe(1);
  expect(h.traces).toEqual([]);
  const probes = h.runs.map((call) => /-Filter '([^']*)'|-Id (\d+)/.exec(call.args[3] ?? "")?.slice(1).find(Boolean));
  expect(probes).toEqual([
    String(RELAY_PID),
    `ProcessId=${RELAY_PID} or ParentProcessId=${RELAY_PID}`,
    String(RELAY_PID),
    String(ROOT_PID),
    `ProcessId=${ROOT_PID}`,
    String(SERVER_PID)
  ]);
});

interface Refusal {
  stamps?: WindowsWorld["stamps"];
  world?: Omit<WindowsWorld, "stamps">;
  /** Ends the relay when the n-th CIM query runs. */
  relayExitsAt?: number;
}

async function refusedRoot({ stamps = STAMPS, world = {}, relayExitsAt }: Refusal) {
  let endRelay = () => {};
  const h = harness({
    run: windowsStamps(stamps, {
      ...world,
      onCim: (query) => {
        if (query === relayExitsAt) endRelay();
      }
    }),
    onSleep: registersServer
  });
  endRelay = h.endChild;
  const failure = await h.io.spawn("clodex", ["server", "--proxy"]).then(
    () => null,
    (error: unknown) => error as Error
  );
  expect(failure, "the spawn owned a root it should have refused").not.toBeNull();
  if (relayExitsAt === undefined) expect(failure!.message).toContain(`pid ${RELAY_PID} was left running`);
  expect(h.traces.map((t) => t.message)).toEqual([`refused to own a root under clodex relay ${RELAY_PID}`]);
  return { message: failure!.message, filters: cimFilters(h.runs) };
}

const EXTRA_ROOT: CimRow = { ...ROOT_ROW, pid: 901, image: CMD };

test("the win32 root is refused when the relay has no inner cmd.exe child", async () => {
  const { message } = await refusedRoot({ world: { table: [RELAY_ROW, CONHOST_ROW] } });
  expect(message).toContain(`clodex relay ${RELAY_PID} has 0 inner cmd.exe candidates`);
});

test("the win32 root is refused when the relay has two inner cmd.exe children", async () => {
  const { message } = await refusedRoot({ world: { table: [...TABLE, EXTRA_ROOT] } });
  expect(message).toContain(`clodex relay ${RELAY_PID} has 2 inner cmd.exe candidates`);
});

test("the win32 root orders creations within one CIM snapshot, never against Get-Process", async () => {
  const stale = { ...ROOT_ROW, created: "2026-09-16T07:14:50.1000009Z" };
  const { message } = await refusedRoot({ world: { table: [RELAY_ROW, CONHOST_ROW, stale] } });
  expect(message).toContain("has 0 inner cmd.exe candidates");

  const picked = harness({
    run: windowsStamps({ ...STAMPS, 901: ROOT_STAMP }, { table: [RELAY_ROW, CONHOST_ROW, stale, EXTRA_ROOT] }),
    onSleep: registersServer
  });
  expect((await picked.io.spawn("clodex", ["server", "--proxy"])).tree.root.pid).toBe(901);

  const earlierByGetProcess = "2026-09-16T07:14:50.0000000Z";
  const h = harness({ run: windowsStamps({ ...STAMPS, [ROOT_PID]: earlierByGetProcess }), onSleep: registersServer });
  expect((await h.io.spawn("clodex", ["server", "--proxy"])).tree.root).toEqual({
    pid: ROOT_PID,
    creationUtc: earlierByGetProcess
  });
});

test("the win32 root orders creations by time, whatever their fraction length", async () => {
  const h = harness({
    run: windowsStamps(STAMPS, {
      table: [
        { ...RELAY_ROW, created: "2026-09-16T07:14:50.5Z" },
        { ...ROOT_ROW, created: "2026-09-16T07:14:50.51Z" }
      ]
    }),
    onSleep: registersServer
  });
  expect((await h.io.spawn("clodex", ["server", "--proxy"])).tree.root.pid).toBe(ROOT_PID);
});

test("the win32 root only counts children whose image is that cmd.exe", async () => {
  const { message } = await refusedRoot({
    world: {
      table: [RELAY_ROW, CONHOST_ROW, { ...ROOT_ROW, image: "C:\\Temp\\cmd.exe" }, { ...EXTRA_ROOT, image: "" }]
    }
  });
  expect(message).toContain("has 0 inner cmd.exe candidates");
});

test("the win32 root is refused when the snapshot does not hold exactly one relay row", async () => {
  for (const table of [[CONHOST_ROW, ROOT_ROW], [RELAY_ROW, RELAY_ROW, ROOT_ROW]]) {
    const { message } = await refusedRoot({ world: { table } });
    expect(message).toContain(`holds ${table.filter((row) => row === RELAY_ROW).length} relay rows`);
  }
});

test("the win32 root is refused when the relay cannot be measured", async () => {
  const { message, filters } = await refusedRoot({ stamps: { [ROOT_PID]: ROOT_STAMP, [SERVER_PID]: SERVER_STAMP } });
  expect(message).toContain(`Cannot measure the creation time of pid ${RELAY_PID}`);
  expect(filters).toEqual([]);
});

test("the win32 root is refused when the relay stamp moves across the listing", async () => {
  const { message } = await refusedRoot({
    stamps: { ...STAMPS, [RELAY_PID]: [RELAY_STAMP, "2026-09-16T07:14:50.1000001Z"] }
  });
  expect(message).toContain(`clodex relay ${RELAY_PID} left during the root discovery`);
});

test("the win32 root is refused when the relay exits during the listing or during the candidate stamp", async () => {
  const listing = await refusedRoot({ relayExitsAt: 0 });
  expect(listing.message).toContain(`clodex relay ${RELAY_PID} left during the root discovery`);
  expect(listing.filters).toHaveLength(1);
  const reread = await refusedRoot({ relayExitsAt: 1 });
  expect(reread.message).toContain(`clodex root candidate ${ROOT_PID} changed while it was stamped`);
});

test("the win32 root is refused when the candidate differs once re-read after its stamp", async () => {
  const other = { code: 1, stdout: "", stderr: "access denied" };
  for (const reread of [
    [{ ...ROOT_ROW, parent: 42 }],
    [{ ...ROOT_ROW, image: CMD }],
    [{ ...ROOT_ROW, created: "2026-09-16T07:14:50.2270011Z" }],
    [],
    [ROOT_ROW, ROOT_ROW]
  ]) {
    const { message, filters } = await refusedRoot({ world: { cim: { 1: reread } } });
    expect(message, JSON.stringify(reread)).toContain(`clodex root candidate ${ROOT_PID} changed while it was stamped`);
    expect(filters).toEqual([`ProcessId=${RELAY_PID} or ParentProcessId=${RELAY_PID}`, `ProcessId=${ROOT_PID}`]);
  }
  const failed = await refusedRoot({ world: { cim: { 1: other } } });
  expect(failed.message).toContain(`cannot list clodex root candidate ${ROOT_PID} (exit 1): access denied`);
});

test("the win32 root is refused when the listing fails or holds an unreadable row", async () => {
  const failed = await refusedRoot({ world: { cim: { 0: { code: 1, stdout: "", stderr: "access denied" } } } });
  expect(failed.message).toContain(`cannot list the children of clodex relay ${RELAY_PID} (exit 1): access denied`);
  const created = ROOT_ROW.created;
  for (const line of [
    `${ROOT_PID} ${CMD}`,
    `x|${RELAY_PID}|${created}|${CMD}`,
    `0|${RELAY_PID}|${created}|${CMD}`,
    `${ROOT_PID}|0|${created}|${CMD}`,
    `${ROOT_PID}|${RELAY_PID}||${CMD}`,
    `${ROOT_PID}|${RELAY_PID}|2026-09-16 07:14:50|${CMD}`,
    "Get-CimInstance : invalid class"
  ]) {
    const stdout = `${cimOutput([RELAY_ROW, CONHOST_ROW]).stdout}${line}\r\n`;
    const unread = await refusedRoot({ world: { cim: { 0: { code: 0, stdout, stderr: "" } } } });
    expect(unread.message, line).toContain(`unreadable listing of the children of clodex relay ${RELAY_PID}`);
  }
});

test("the win32 spawn refuses a SystemRoot it cannot glue unquoted into the command line", async () => {
  for (const root of ["C:\\Program Files\\Win", "C:\\Win&calc", 'C:\\"Win"', "C:\\Win|x", "C:\\Win^x", "C:\\%Win%", "C:\\Win!x!"]) {
    const h = harness({ env: { SystemRoot: root } });
    await expect(h.io.spawn("clodex", ["server", "--proxy"]), root).rejects.toThrow(/cannot glue/);
    expect(h.spawns, root).toHaveLength(0);
  }
  for (const root of ["C:\\Windows\\..\\Evil", "C:\\..", "C:/Windows/.."]) {
    const h = harness({ env: { SystemRoot: root } });
    await expect(h.io.spawn("clodex", ["server", "--proxy"]), root).rejects.toThrow(/\.\. segment/);
    expect(h.spawns, root).toHaveLength(0);
  }
  const dotted = harness({ env: { SystemRoot: "C:\\Win..dows" } });
  await expect(dotted.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy in time/);
});
test("the win32 spawn disables the current-directory lookup whatever the inherited value", async () => {
  const h = harness({ env: { SYSTEMROOT: "C:\\Windows\\", nodefaultcurrentdirectoryinexepath: "0" } });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy in time/);
  const { file, options } = h.spawns[0]!;
  expect(file).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(options.cwd).toBe(HOME);
  const lookup = Object.entries(options.env ?? {}).filter(
    ([key]) => key.toLowerCase() === "nodefaultcurrentdirectoryinexepath"
  );
  expect(lookup).toEqual([["NoDefaultCurrentDirectoryInExePath", "1"]]);
});

test("the win32 spawn keeps only drive-absolute PATH entries, under the inherited key", async () => {
  const inherited = [
    "",
    ".",
    ".\\",
    "C:\\Tools",
    "bin",
    "\\Windows",
    "C:relative",
    "\\\\server\\share\\bin",
    '"C:\\Program Files\\x"',
    '"C:\\odd;dir"',
    '"sub;dir"',
    "D:/forward",
    ""
  ].join(";");
  const kept = ["C:\\Tools", '"C:\\Program Files\\x"', '"C:\\odd;dir"', "D:/forward"].join(";");
  for (const key of ["Path", "PATH", "path"]) {
    const h = harness({ env: { SystemRoot: SYSTEM_ROOT, [key]: inherited } });
    await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy in time/);
    const paths = Object.entries(h.spawns[0]!.options.env ?? {}).filter(([name]) => name.toLowerCase() === "path");
    expect(paths, key).toEqual([[key, kept]]);
  }
});

test("the win32 spawn adds no PATH the parent did not have", async () => {
  const h = harness();
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy in time/);
  const names = Object.keys(h.spawns[0]!.options.env ?? {}).map((name) => name.toLowerCase());
  expect(names).not.toContain("path");
});

test("the win32 spawn starts in the clodex home the runtime manifest is read from", async () => {
  // Without CLODEX_HOME the home derives from the real profile, absolute only on a Windows host.
  const homes = process.platform === "win32" ? [HOME, "D:\\Users\\op\\custom-clodex", null] : [HOME];
  for (const home of homes) {
    const expected = clodexHome(home === null ? {} : { CLODEX_HOME: home });
    const h = harness({ home });
    await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy in time/);
    expect(h.spawns[0]!.options.cwd, String(home)).toBe(expected);
    expect(h.madeDirs, String(home)).toEqual([expected]);
  }
  expect(clodexHome({})).toBe(join(homedir(), ".clodex"));
});

test("the win32 spawn creates a missing clodex home before starting the child", async () => {
  const spawnsAtCreation: number[] = [];
  const h = harness({ makeDir: () => spawnsAtCreation.push(h.spawns.length) });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy in time/);
  expect(spawnsAtCreation).toEqual([0]);
  expect(h.spawns).toHaveLength(1);
});

test("the win32 spawn fails, naming the path, when the clodex home cannot be created", async () => {
  const h = harness({
    log: 7,
    makeDir: (path) => {
      throw Object.assign(new Error(`EACCES: permission denied, mkdir '${path}'`), { code: "EACCES" });
    }
  });
  const failure = h.io.spawn("clodex", ["server", "--proxy"]);
  await expect(failure).rejects.toThrow("cannot create the clodex home C:\\clodex-home: EACCES");
  expect(h.spawns).toHaveLength(0);
});

test("the win32 spawn refuses a clodex home that is not absolute", async () => {
  for (const home of ["clodex-home", ".\\clodex", "\\clodex-home", "C:clodex", "\\\\server\\share\\clodex"]) {
    const h = harness({ home });
    await expect(h.io.spawn("clodex", ["server", "--proxy"]), home).rejects.toThrow(/absolute clodex home/);
    expect(h.madeDirs, home).toHaveLength(0);
    expect(h.spawns, home).toHaveLength(0);
  }
});

test("the win32 spawn ignores ComSpec, absolute or relative", async () => {
  for (const env of [
    { COMSPEC: "D:\\Tools\\cmd.exe" },
    { ComSpec: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
    { ComSpec: "cmd.exe" },
    { ComSpec: ".\\cmd.exe" },
    { ComSpec: "\\Windows\\System32\\cmd.exe" }
  ]) {
    const h = harness({ env: { SystemRoot: SYSTEM_ROOT, ...env } });
    await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy in time/);
    expect(h.spawns[0]!.file, JSON.stringify(env)).toBe("C:\\Windows\\System32\\cmd.exe");
  }
});

test("the win32 spawn refuses to start without an absolute SystemRoot", async () => {
  for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "Windows" }, { ComSpec: "C:\\Windows\\System32\\cmd.exe" }]) {
    const h = harness({ env, log: 7 });
    await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/absolute SystemRoot/);
    expect(h.spawns, JSON.stringify(env)).toHaveLength(0);
  }
});

test("no win32 spawn goes through PowerShell, which exits without running its command when detached", async () => {
  const launchers = /^(powershell|pwsh)(\.exe)?$/;
  for (const shell of [undefined, "", "powershell.exe", "pwsh.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"]) {
    const h = harness({ shell });
    await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow();
    expect(h.spawns).toHaveLength(1);
    const spawned = h.spawns[0]!;
    const words = [spawned.file, ...spawned.args.flatMap((arg) => arg.split(/\s+/))];
    const launched = words
      .map((word) => word.replaceAll('"', "").split(/[\\/]/).pop()!.toLowerCase())
      .filter((name) => launchers.test(name));
    expect(launched, `SHELL=${String(shell)} spawned ${spawned.file} ${spawned.args.join(" ")}`).toEqual([]);
  }
});

test("spawn on posix proves the root leads its own group", async () => {
  const h = harness({
    platform: "linux",
    env: { PATH: ".:bin:/usr/bin" },
    files: {
      [`/proc/${ROOT_PID}/stat`]: procStat(ROOT_PID, ROOT_PID, "4455667"),
      [`/proc/${SERVER_PID}/stat`]: procStat(SERVER_PID, ROOT_PID, "4455999")
    },
    onSleep: (files) => files.set(RUNTIME, JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]))
  });
  const owner = await h.io.spawn("clodex", ["server", "--proxy", "--ws-diagnostics", "--no-discovery"]);
  expect(owner).toEqual(posixOwner());
  expect(h.spawns[0]?.file).toBe("/bin/bash");
  expect(h.spawns[0]?.args).toEqual([
    "-l",
    "-c",
    "clodex server --proxy --ws-diagnostics --no-discovery"
  ]);
  expect(h.spawns[0]?.options.detached).toBe(true);
  expect(h.madeDirs).toEqual([]);
  expect(h.spawns[0]?.options.cwd).toBeUndefined();
  expect(h.spawns[0]?.options.env, "the posix child inherits the environment unfiltered").toBeUndefined();
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
    new RegExp(`none can be owned; pid ${RELAY_PID} was left running`)
  );
});

test("spawn names the pid it leaves running when no proxy registers in time", async () => {
  const h = harness();
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(
    new RegExp(`did not register a proxy in time; pid ${RELAY_PID} was left running`)
  );
});

test("spawn names the pid it leaves running when the owner cannot be measured", async () => {
  const h = harness({
    run: windowsStamps({}),
    onSleep: (files) => files.set(RUNTIME, JSON.stringify([record(SERVER_PID, PORT, SERVER_STARTED)]))
  });
  await expect(h.io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(
    new RegExp(`Cannot measure the creation time of pid .*; pid ${RELAY_PID} was left running`)
  );
});

test("spawn rejects a structurally valid listening exposure absent from the name allow-list", async () => {
  const h = harness();
  await expect(h.io.spawn("clodex", ["server", "--proxy", "--listen=0.0.0.0"])).rejects.toThrow(
    "accept only --ws-diagnostics and --no-discovery"
  );
  expect(h.spawns).toHaveLength(0);
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
