import { expect, test } from "bun:test";
import type { IPty } from "node-pty";
import { PtyManager } from "../desktop/src/main/pty-manager.ts";

type DataListener = (data: string) => void;
type ExitListener = (event: { exitCode: number }) => void;
type SpawnArgs = Parameters<typeof import("node-pty").spawn>;

class FakePty {
  private dataListener: DataListener | null = null;
  private exitListener: ExitListener | null = null;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killCalls = 0;
  killError: unknown = null;

  constructor(readonly pid: number) {}

  onData(listener: DataListener): void {
    this.dataListener = listener;
  }

  onExit(listener: ExitListener): void {
    this.exitListener = listener;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killCalls++;
    if (this.killError) throw this.killError;
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitExit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }

  asIPty(): IPty {
    return this as unknown as IPty;
  }
}

class FakePtyAdapter {
  readonly calls: Array<{
    file: SpawnArgs[0];
    args: string[];
    cwd: SpawnArgs[2]["cwd"];
    env: SpawnArgs[2]["env"];
    cols: number;
    rows: number;
    proc: FakePty;
  }> = [];

  spawn(...[file, args, options]: SpawnArgs): IPty {
    const proc = new FakePty(this.calls.length + 1);
    this.calls.push({
      file,
      args: typeof args === "string" ? [args] : args,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols ?? 0,
      rows: options.rows ?? 0,
      proc
    });
    return proc.asIPty();
  }
}

class FakeTimers {
  private readonly timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];

  setTimeout(callback: () => void, delay: number): NodeJS.Timeout {
    const timer = { callback, delay, cleared: false };
    this.timers.push(timer);
    return timer as unknown as NodeJS.Timeout;
  }

  clearTimeout(timer: NodeJS.Timeout): void {
    (timer as unknown as { cleared: boolean }).cleared = true;
  }

  activeCount(delay?: number): number {
    return this.timers.filter((timer) => !timer.cleared && (delay === undefined || timer.delay === delay)).length;
  }

  fire(delay: number): void {
    for (const timer of this.timers) {
      if (!timer.cleared && timer.delay === delay) {
        timer.cleared = true;
        timer.callback();
      }
    }
  }
}

function opts(command: string, shell = "powershell.exe") {
  return { command, shell, interactive: false };
}

function createManager(adapter: FakePtyAdapter, timers = new FakeTimers()) {
  const reports: Array<[string, string, unknown]> = [];
  const scans: unknown[] = [];
  const marker = { live: true };
  let scanCount = 0;
  const manager = new PtyManager({
    pty: adapter,
    now: () => 1_000,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    reportError: (scope, message, error) => reports.push([scope, message, error]),
    scanJobStartup: ((status: unknown) => {
      scans.push(status);
      scanCount++;
      if (scanCount === 1) return { status: marker, reportFailure: false };
      if (scanCount === 2) return { status: null, reportFailure: true };
      return { status: null, reportFailure: false };
    }) as never
  });
  return { manager, reports, scans, marker, timers };
}

function retiredOf(manager: PtyManager): Map<IPty, unknown> {
  return (manager as unknown as { retired: Map<IPty, unknown> }).retired;
}

test("PtyManager makes a killed tile unavailable while retaining its process by identity", () => {
  const adapter = new FakePtyAdapter();
  const { manager, timers } = createManager(adapter);

  manager.spawn("tile-7", "C:/work", opts("first"));
  const first = adapter.calls[0]!.proc;
  manager.kill("tile-7");

  expect(manager.isAlive("tile-7")).toBe(false);
  expect(manager.pid("tile-7")).toBeNull();
  expect(manager.write("tile-7", "dropped")).toBe(false);
  expect(first.killCalls).toBe(1);
  expect(retiredOf(manager).has(first.asIPty())).toBe(true);
  expect(timers.activeCount(3_000)).toBe(1);
});

test("PtyManager immediately replaces a killed generation and ignores its data and exit", () => {
  const adapter = new FakePtyAdapter();
  const { manager } = createManager(adapter);
  const data: string[] = [];
  const exits: Array<{ id: string; exitCode: number }> = [];
  manager.on("data", ({ data: chunk }) => data.push(chunk));
  manager.on("exit", (event) => exits.push(event));

  expect(manager.spawn("tile-7", "C:/first", opts("first"))).toBe(1);
  const first = adapter.calls[0]!.proc;
  expect(manager.spawn("tile-7", "C:/second", opts("second"))).toBe(2);
  const second = adapter.calls[1]!.proc;

  expect(manager.isAlive("tile-7")).toBe(true);
  expect(manager.pid("tile-7")).toBe(second.pid);
  expect(retiredOf(manager).has(first.asIPty())).toBe(true);
  expect(manager.write("tile-7", "new input")).toBe(true);
  expect(second.writes).toEqual(["new input"]);

  first.emitData("old output");
  first.emitExit(9);
  second.emitData("new output");

  expect(data).toEqual(["new output"]);
  expect(exits).toEqual([]);
  expect(retiredOf(manager).size).toBe(0);
  expect(manager.pid("tile-7")).toBe(second.pid);

  second.emitExit(0);
  expect(exits).toEqual([{ id: "tile-7", exitCode: 0 }]);
});

test("PtyManager reports one unacknowledged retired process and retains it until exit", () => {
  const adapter = new FakePtyAdapter();
  const { manager, reports, timers } = createManager(adapter);

  manager.spawn("tile-7", "C:/work", opts("first"));
  const first = adapter.calls[0]!.proc;
  manager.kill("tile-7");
  timers.fire(3_000);

  expect(first.killCalls).toBe(1);
  expect(reports).toHaveLength(1);
  expect(reports[0]![0]).toBe("pty");
  expect(reports[0]![1]).toContain("tile-7");
  expect(reports[0]![1]).toContain("1");
  expect(retiredOf(manager).has(first.asIPty())).toBe(true);
  expect(timers.activeCount()).toBe(0);

  first.emitExit();
  expect(retiredOf(manager).size).toBe(0);
  expect(timers.activeCount()).toBe(0);
  expect(reports).toHaveLength(1);
});

test("PtyManager killAll reissues kill for a retained old process", () => {
  const adapter = new FakePtyAdapter();
  const { manager } = createManager(adapter);

  manager.spawn("tile-7", "C:/work", opts("first"));
  const first = adapter.calls[0]!.proc;
  manager.kill("tile-7");
  manager.killAll();

  expect(first.killCalls).toBe(2);
});

test("PtyManager reports synchronous failures while retaining the old process for a later killAll", () => {
  const adapter = new FakePtyAdapter();
  const { manager, reports } = createManager(adapter);
  const failure = new Error("access denied");

  manager.spawn("tile-7", "C:/work", opts("first"));
  const first = adapter.calls[0]!.proc;
  first.killError = failure;
  manager.kill("tile-7");

  expect(manager.isAlive("tile-7")).toBe(false);
  expect(retiredOf(manager).has(first.asIPty())).toBe(true);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toEqual(["pty", expect.stringContaining("tile-7"), failure]);

  first.killError = null;
  manager.killAll();
  expect(first.killCalls).toBe(2);
});

test("PtyManager applies terminal JobStartup status updates through handleData", () => {
  const adapter = new FakePtyAdapter();
  const { manager, reports, scans, marker } = createManager(adapter);

  manager.spawn("tile-7", "C:/work", opts("first"));
  const proc = adapter.calls[0]!.proc;
  proc.emitData("first");
  proc.emitData("second");
  proc.emitData("third");

  expect(scans).toHaveLength(3);
  expect(scans[1]).toBe(marker);
  expect(scans[2]).toBeNull();
  expect(reports).toEqual([["pty", "kory-job: tree kill disabled for tile tile-7", undefined]]);
});
