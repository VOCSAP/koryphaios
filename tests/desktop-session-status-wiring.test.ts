// SessionService wiring of the per-tile statusLine report, driven through the
// real class: which spawns get `--settings`, and what the peer poll broadcasts
// from the status file. node-pty is replaced by a fake that records the spawn
// line, store.ts (electron) by a no-op persist; the `@shared/*` aliases, which
// bun does not resolve from desktop/, are pointed at the real modules.
import { test, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
}
const spawned: FakeProc[] = [];
let nextPid = 40000;

mock.module("node-pty", () => ({
  spawn(file: string, args: string[]) {
    let onExit: ((e: { exitCode: number }) => void) | null = null;
    const proc: FakeProc & Record<string, unknown> = {
      pid: nextPid++,
      file,
      args,
      exit: (code: number) => onExit?.({ exitCode: code }),
      onData: () => ({ dispose() {} }),
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
const { STATUS_SILENCE_MS } = await import("../desktop/src/main/session-status-file.ts");
const { onDeckError } = await import("../desktop/src/main/log.ts");

const SETTINGS = "/deck/state/deck-statusline-abc.json";

const tmpDirs: string[] = [];
const services: InstanceType<typeof SessionService>[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  spawned.length = 0;
});

function setup(opts: { sandboxPeersDir?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kory-status-wiring-"));
  tmpDirs.push(home);
  const cwd = join(home, "proj");
  mkdirSync(cwd, { recursive: true });
  const config = { projectDir: cwd, shell: "/bin/sh", interactiveShell: false } as never;
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
  spawned.at(-1)!.exit(0); // clean /exit auto-closes the tile
  expect(existsSync(join(peersDir, `desk-status-${rt.id}.json`)), "clean exit leaves no status file").toBe(false);

  const rt2 = svc.create({});
  writeStatus(peersDir, rt2.id, "Opus", Date.now() + 1);
  spawned.at(-1)!.exit(1); // crashed: stays as a dead tile
  await svc.remove(rt2.id);
  expect(existsSync(join(peersDir, `desk-status-${rt2.id}.json`)), "remove leaves no status file").toBe(false);
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
