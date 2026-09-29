// SessionService.refreshLiveSessionIds driven through the real class: which
// back-channel write a spawned tile adopts at save time. node-pty and store.ts
// (electron) are replaced by factories carrying their whole runtime export
// surface; the `@shared/*` aliases bun cannot resolve from desktop/ point at
// the real modules.
import { test, expect, mock, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DESKTOP_SRC = join(import.meta.dir, "..", "desktop", "src");
for (const name of ["session-status", "palette", "role", "reorder", "workflow", "announce", "types"]) {
  const real = join(DESKTOP_SRC, "shared", `${name}.ts`);
  if (existsSync(real)) mock.module(`@shared/${name}`, () => require(real));
}

function fakePty() {
  return {
    pid: 42000,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
    kill() {},
  };
}
mock.module("node-pty", () => ({
  spawn: fakePty,
  fork: fakePty,
  createTerminal: fakePty,
  open: () => {
    throw new Error("node-pty open is not faked");
  },
  native: null,
}));
mock.module(join(DESKTOP_SRC, "main", "store.ts"), () => ({
  saveSessions: () => {},
  loadConfig: () => ({}),
  saveConfig: () => {},
  DEFAULT_CONFIG: {},
}));

const { SessionService } = await import("../desktop/src/main/session-service.ts");
const { encodeProjectDir } = await import("../desktop/src/main/session-transcript.ts");
const { deskSessionFileName } = await import("../desktop/src/main/desk-session.ts");

const tmpDirs: string[] = [];
const services: InstanceType<typeof SessionService>[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spawnTile() {
  const home = mkdtempSync(join(tmpdir(), "kory-live-rotation-"));
  tmpDirs.push(home);
  const cwd = join(home, "proj");
  mkdirSync(cwd, { recursive: true });
  const config = { projectDir: cwd, shell: "/bin/sh", interactiveShell: false } as never;
  const svc = new SessionService(() => config, () => ({}), "claude", () => "", home);
  services.push(svc);
  const { id } = svc.create({});
  const peers = join(home, ".claude", "peers");
  mkdirSync(peers, { recursive: true });
  const projects = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(projects, { recursive: true });
  // Synchronous from the write to the refresh: the discovery poll cannot run
  // in between, so what gets adopted is refreshLiveSessionIds' decision alone.
  const writeAndRefresh = (sid: string, source: string): string => {
    writeFileSync(join(projects, `${sid}.jsonl`), "{}\n", "utf-8");
    writeFileSync(join(peers, deskSessionFileName(id)), JSON.stringify({ sid, source }), "utf-8");
    svc.refreshLiveSessionIds();
    const tile = svc.list().find((t) => t.id === id);
    if (!tile) throw new Error(`tile ${id} not listed`);
    return tile.sessionId;
  };
  return { writeAndRefresh };
}

test("a tile with no real id yet adopts its first write at save time, even a late register", () => {
  const { writeAndRefresh } = spawnTile();
  expect(writeAndRefresh("tile-real-x", "register")).toBe("tile-real-x");
});

test("once a real id is adopted, a later register write is ignored and a /clear rotation is adopted", () => {
  const { writeAndRefresh } = spawnTile();
  expect(writeAndRefresh("tile-real-x", "register"), "first write").toBe("tile-real-x");
  expect(writeAndRefresh("child-probe-y", "register"), "a child's register after adoption").toBe("tile-real-x");
  expect(writeAndRefresh("rotated-z", "clear"), "the tile's own /clear").toBe("rotated-z");
});
