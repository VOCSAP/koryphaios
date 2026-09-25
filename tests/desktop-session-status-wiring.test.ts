// SessionService wiring of the per-tile statusLine report, driven through the
// real class: which spawns get `--settings`, and what the peer poll broadcasts
// from the status file. node-pty is replaced by a fake that records the spawn
// line, store.ts (electron) by a no-op persist; the `@shared/*` aliases, which
// bun does not resolve from desktop/, are pointed at the real modules.
import { test, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHARED = join(import.meta.dir, "..", "desktop", "src", "shared");
for (const name of ["session-status", "palette", "role", "reorder", "workflow", "announce", "types"]) {
  const real = join(SHARED, `${name}.ts`);
  if (existsSync(real)) mock.module(`@shared/${name}`, () => require(real));
}

interface FakeProc {
  pid: number;
  file: string;
  args: string[];
  exit(code: number): void;
  /** Deliver PTY output as node-pty's onData would. */
  output(data: string): void;
}
const spawned: FakeProc[] = [];
let nextPid = 40000;

mock.module("node-pty", () => ({
  spawn(file: string, args: string[]) {
    let onExit: ((e: { exitCode: number }) => void) | null = null;
    let onData: ((d: string) => void) | null = null;
    const proc: FakeProc & Record<string, unknown> = {
      pid: nextPid++,
      file,
      args,
      exit: (code: number) => onExit?.({ exitCode: code }),
      output: (d: string) => onData?.(d),
      onData: (cb: (d: string) => void) => {
        onData = cb;
        return { dispose() {} };
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        onExit = cb;
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill() {},
    };
    spawned.push(proc);
    return proc;
  },
}));
mock.module(join(import.meta.dir, "..", "desktop", "src", "main", "store.ts"), () => ({
  saveSessions: () => {},
}));

const { SessionService } = await import("../desktop/src/main/session-service.ts");
const { encodeProjectDir } = await import("../desktop/src/main/session-transcript.ts");
const { STATUS_FILE_VERSION } = await import("../desktop/src/shared/session-status.ts");
const { STATUS_SILENCE_MS, STALE_STATUS_FILE_MS } = await import("../desktop/src/main/session-status-file.ts");
const { onDeckError } = await import("../desktop/src/main/log.ts");

const SETTINGS = "/deck/state/deck-statusline-abc.json";

const tmpDirs: string[] = [];
const services: InstanceType<typeof SessionService>[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  spawned.length = 0;
});

function setup(opts: { sandboxPeersDir?: string; liveStatusLine?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kory-status-wiring-"));
  tmpDirs.push(home);
  const cwd = join(home, "proj");
  mkdirSync(cwd, { recursive: true });
  const config = {
    projectDir: cwd,
    shell: "/bin/sh",
    interactiveShell: false,
    ...(opts.liveStatusLine === undefined ? {} : { liveStatusLine: opts.liveStatusLine }),
  } as never;
  const svc = new SessionService(() => config, () => ({}), "claude", () => "", home);
  services.push(svc);
  svc.setStatusLineSettingsProvider(() => SETTINGS);
  if (opts.sandboxPeersDir) svc.setSandboxProvider(() => null, undefined, () => opts.sandboxPeersDir!);
  const broadcasts: Array<Array<{ id: string; liveStatus: { model: string } | null }>> = [];
  svc.on("changed", (list) => broadcasts.push(list));
  return { svc, home, cwd, broadcasts, peersDir: join(home, ".claude", "peers") };
}

function lastLine(): string {
  const p = spawned.at(-1);
  if (!p) throw new Error("nothing spawned");
  return p.args.join(" ");
}

function writeStatus(peersDir: string, id: string, model: string, at: number): void {
  mkdirSync(peersDir, { recursive: true });
  writeFileSync(
    join(peersDir, `desk-status-${id}.json`),
    JSON.stringify({ v: STATUS_FILE_VERSION, model_id: `id-${model}`, model, pct: 10, size: 200000, at }),
  );
}

function poll(svc: unknown): void {
  (svc as { pollPeerIds(): void }).pollPeerIds();
}

test("a host Claude Code tile gets --settings", () => {
  const { svc } = setup();
  svc.create({});
  expect(lastLine(), "claude tile launched with the Deck statusLine").toContain(`--settings "${SETTINGS}"`);
});

test("a sandboxed tile gets no --settings, the supervisor still does", () => {
  const sbx = mkdtempSync(join(tmpdir(), "kory-sbx-peers-"));
  tmpDirs.push(sbx);
  const { svc } = setup({ sandboxPeersDir: sbx });
  svc.create({});
  expect(lastLine(), "sandboxed tile: host hook path unreachable, no flag").not.toContain("--settings");
  svc.create({ supervisor: true } as never);
  expect(lastLine(), "supervisor is never sandboxed: flag kept").toContain(`--settings "${SETTINGS}"`);
});

test("a non-Claude tile gets no --settings", () => {
  const { svc } = setup();
  svc.create({ command: "bash" });
  expect(lastLine(), "plain shell tile: no statusLine to install").not.toContain("--settings");
});

test("a resumed (forked) spawn gets --settings too", () => {
  const { svc, home, cwd } = setup();
  const rt = svc.create({});
  // Make the session resumable: a transcript exists and the process died.
  const projDir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${rt.sessionId}.jsonl`), "{}\n");
  spawned.at(-1)!.exit(1);
  svc.restart(rt.id);
  const line = lastLine();
  expect(line, "restart took the resume path").toContain("--fork-session");
  expect(line, "resume spawn launched with the Deck statusLine").toContain(`--settings "${SETTINGS}"`);
});

test("poll: model A then B reach the broadcast; a report older than the spawn is ignored", () => {
  const { svc, broadcasts, peersDir } = setup();
  const rt = svc.create({});
  const modelOf = (): string | null => broadcasts.at(-1)!.find((s) => s.id === rt.id)!.liveStatus?.model ?? null;

  writeStatus(peersDir, rt.id, "Stale", 1000);
  const before = broadcasts.length;
  poll(svc);
  expect(broadcasts.length, "a pre-spawn report changes nothing").toBe(before);
  expect(svc.list()[0].liveStatus, "pre-spawn report not shown").toBeNull();

  writeStatus(peersDir, rt.id, "Opus", Date.now() + 1);
  poll(svc);
  expect(modelOf(), "first report broadcast").toBe("Opus");

  writeStatus(peersDir, rt.id, "Sonnet", Date.now() + 2);
  poll(svc);
  expect(modelOf(), "a /model switch reaches the broadcast").toBe("Sonnet");
});

test("the status file is removed when the tile is closed for good", async () => {
  const { svc, peersDir } = setup();
  const rt = svc.create({});
  writeStatus(peersDir, rt.id, "Opus", Date.now() + 1);
  writeFileSync(join(peersDir, `desk-statusline-cache-${rt.id}.json`), "{}");
  spawned.at(-1)!.exit(0); // clean /exit auto-closes the tile
  expect(existsSync(join(peersDir, `desk-status-${rt.id}.json`)), "clean exit leaves no status file").toBe(false);
  expect(existsSync(join(peersDir, `desk-statusline-cache-${rt.id}.json`)), "clean exit leaves no statusLine cache").toBe(false);

  const rt2 = svc.create({});
  writeStatus(peersDir, rt2.id, "Opus", Date.now() + 1);
  spawned.at(-1)!.exit(1); // crashed: stays as a dead tile
  writeFileSync(join(peersDir, `desk-statusline-cache-${rt2.id}.json`), "{}");
  await svc.remove(rt2.id);
  expect(existsSync(join(peersDir, `desk-status-${rt2.id}.json`)), "remove leaves no status file").toBe(false);
  expect(existsSync(join(peersDir, `desk-statusline-cache-${rt2.id}.json`)), "remove leaves no statusLine cache").toBe(false);
});

test("silent statusLine: reported once per spawn after the grace period, never once a report arrived", () => {
  const errors: string[] = [];
  onDeckError((_scope, text) => errors.push(text));
  const { svc, peersDir } = setup();
  const runtime = (svc as unknown as { runtime: Map<string, { spawnedAt: number }> }).runtime;
  const silent = (): string[] => errors.filter((e) => e.includes("no statusLine report"));

  const quiet = svc.create({ name: "quiet" });
  poll(svc);
  expect(silent(), "no warning inside the grace period").toEqual([]);
  runtime.get(quiet.id)!.spawnedAt = Date.now() - STATUS_SILENCE_MS - 1;
  poll(svc);
  poll(svc);
  expect(silent().length, "warned exactly once for the silent spawn").toBe(1);
  expect(silent()[0], "names the tile and the likely causes").toContain('"quiet"');
  expect(silent()[0], "names the likely causes").toContain("disableAllHooks");

  const talking = svc.create({ name: "talking" });
  writeStatus(peersDir, talking.id, "Opus", Date.now() + 1);
  poll(svc);
  runtime.get(talking.id)!.spawnedAt = Date.now() - STATUS_SILENCE_MS - 1;
  poll(svc);
  expect(silent().filter((e) => e.includes('"talking"')), "a tile that reported is never flagged").toEqual([]);

  const shell = svc.create({ name: "shell", command: "bash" });
  runtime.get(shell.id)!.spawnedAt = Date.now() - STATUS_SILENCE_MS - 1;
  poll(svc);
  expect(silent().filter((e) => e.includes('"shell"')), "a tile without --settings is never flagged").toEqual([]);
});

test("liveStatusLine off: no --settings on any spawn, and a status file found is never shown", () => {
  const { svc, peersDir, home, cwd } = setup({ liveStatusLine: false });
  const rt = svc.create({});
  expect(lastLine(), "fresh spawn without the Deck statusLine").not.toContain("--settings");
  svc.create({ supervisor: true } as never);
  expect(lastLine(), "supervisor spawn without the Deck statusLine").not.toContain("--settings");
  writeStatus(peersDir, rt.id, "Opus", Date.now() + 1);
  poll(svc);
  expect(svc.list().find((s) => s.id === rt.id)!.liveStatus, "no statusLine installed: liveStatus stays null").toBeNull();

  const projDir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${rt.sessionId}.jsonl`), "{}\n");
  spawned.find((p) => p.args.join(" ").includes(rt.sessionId))!.exit(1);
  svc.restart(rt.id);
  expect(lastLine(), "resume path taken").toContain("--fork-session");
  expect(lastLine(), "resume spawn without the Deck statusLine").not.toContain("--settings");
});

test("liveStatusLine explicitly on behaves as the default", () => {
  const { svc } = setup({ liveStatusLine: true });
  svc.create({});
  expect(lastLine(), "flag passed when the setting is on").toContain(`--settings "${SETTINGS}"`);
});

test("silent statusLine: no warning while the tile waits on the operator; clock restarts when it stops", () => {
  const errors: string[] = [];
  onDeckError((_scope, text) => errors.push(text));
  const { svc } = setup();
  const internals = svc as unknown as {
    runtime: Map<string, { spawnedAt: number; liveStatusAttentionAt: number }>;
    attentionDetector: { emit(ev: string, e: unknown): void };
  };
  const silent = (): string[] => errors.filter((e) => e.includes("no statusLine report") && e.includes('"trusting"'));

  const rt = svc.create({ name: "trusting" });
  internals.runtime.get(rt.id)!.spawnedAt = Date.now() - 3 * STATUS_SILENCE_MS;
  const trustCapture: Array<{ data: string }> = JSON.parse(
    readFileSync(join(import.meta.dir, "pty-harness", "fixtures", "trust-dialog-quick-safety-check.json"), "utf-8"),
  );
  const pty = spawned.at(-1)!;
  for (const c of trustCapture.slice(0, 4)) pty.output(c.data);
  expect(svc.list().find((s) => s.id === rt.id)!.needsAttention, "the real trust dialog bytes raise attention").toBe(true);
  poll(svc);
  expect(silent(), "trust dialog on screen: no warning though the spawn is old").toEqual([]);
  internals.runtime.get(rt.id)!.liveStatusAttentionAt = Date.now() - 2 * STATUS_SILENCE_MS;
  poll(svc);
  expect(silent(), "dialog still on screen minutes later: no warning").toEqual([]);

  internals.attentionDetector.emit("attention", { id: rt.id, waiting: false });
  poll(svc);
  expect(silent(), "attention just cleared: the 60 s clock restarts").toEqual([]);

  internals.runtime.get(rt.id)!.liveStatusAttentionAt = Date.now() - STATUS_SILENCE_MS - 1;
  poll(svc);
  poll(svc);
  expect(silent().length, "silent 60 s after the attention cleared: warned exactly once").toBe(1);

  internals.attentionDetector.emit("attention", { id: rt.id, waiting: true });
  internals.attentionDetector.emit("attention", { id: rt.id, waiting: false });
  internals.runtime.get(rt.id)!.liveStatusAttentionAt = Date.now() - STATUS_SILENCE_MS - 1;
  poll(svc);
  expect(silent().length, "still at most once per spawn").toBe(1);
});

test("start and restore sweep old status leftovers of unknown tiles, keep fresh foreign and own files", () => {
  const { svc, peersDir } = setup();
  mkdirSync(peersDir, { recursive: true });
  const old = (Date.now() - STALE_STATUS_FILE_MS - 60_000) / 1000;
  const put = (name: string, mtimeS?: number): string => {
    const p = join(peersDir, name);
    writeFileSync(p, "{}");
    if (mtimeS !== undefined) utimesSync(p, mtimeS, mtimeS);
    return p;
  };
  const oldForeign = put("desk-status-gone-tile.json", old);
  const oldForeignCache = put("desk-statusline-cache-gone-tile.json.77.tmp", old);
  const freshForeign = put("desk-status-other-deck-tile.json");
  svc.start();
  expect(existsSync(oldForeign), "old foreign status file swept at start").toBe(false);
  expect(existsSync(oldForeignCache), "old foreign cache temp swept at start").toBe(false);
  expect(existsSync(freshForeign), "fresh foreign file (another live Deck) kept").toBe(true);

  const restored = { ...svc.create({ name: "r" }), id: "restored-tile" };
  const ownOld = put("desk-statusline-cache-restored-tile.json", old);
  const oldForeign2 = put("desk-statusline-cache-gone-2.json", old);
  svc.restoreFrom([restored as never]);
  expect(existsSync(oldForeign2), "old foreign cache swept at restore").toBe(false);
  expect(existsSync(ownOld), "a restored tile's own file is never swept").toBe(true);
});
