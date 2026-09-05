// The sibling temp file every JSON store in desktop/src/main writes through.
// Two properties are load-bearing and neither is visible from a caller: the
// temp name is unique per process AND per call (a shared `<file>.tmp` is a
// second window's write buffer, and whoever renames last publishes whatever
// the other one had written into it), and a failed write takes its own temp
// file with it instead of piling one up per attempt.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempFileName, writeFileAtomic } from "../desktop/src/main/atomic-write.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-atomic-"));
  dirs.push(d);
  return d;
}

test("the temp name carries this process' pid and a per-call random suffix", () => {
  const file = join(freshDir(), "state.json");
  const names = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const tmp = tempFileName(file);
    expect(tmp.startsWith(`${file}.${process.pid}.`)).toBe(true);
    expect(tmp.endsWith(".tmp")).toBe(true);
    names.add(tmp);
  }
  // 50 distinct names out of 50 calls: a constant suffix (or one derived from
  // the pid alone) would collapse this set to 1 and let a second call of the
  // same process adopt a previous, interrupted write's buffer.
  expect(names.size).toBe(50);
});

test("the temp name is a SIBLING of the target, so the rename stays on one filesystem", () => {
  // A temp file placed in os.tmpdir() would make renameSync fail with EXDEV
  // whenever the target lives on another mount -- the atomicity would be lost
  // exactly on the machines where it is hardest to notice.
  const file = join(freshDir(), "state.json");
  expect(tempFileName(file).startsWith(`${file}.`)).toBe(true);
});

test("a successful write replaces the file and leaves nothing else in the directory", () => {
  const dir = freshDir();
  const file = join(dir, "state.json");
  writeFileSync(file, "old", "utf-8");
  writeFileAtomic(file, "new");
  expect(readFileSync(file, "utf-8")).toBe("new");
  expect(readdirSync(dir)).toEqual(["state.json"]);
});

test("mode is applied to the temp file, so the published file is never briefly world-readable", () => {
  if (process.platform === "win32") return; // POSIX mode bits only
  const file = join(freshDir(), "secret.json");
  writeFileAtomic(file, "{}", { mode: 0o600 });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a failed write removes its own temp file and rethrows the original failure", () => {
  // renameSync onto an existing DIRECTORY fails: the write itself succeeded,
  // so this exercises the path where a temp file really exists at the moment
  // the error is raised.
  const dir = freshDir();
  const target = join(dir, "state.json");
  mkdirSync(target);
  mkdirSync(join(target, "occupied"));
  expect(() => writeFileAtomic(target, "new")).toThrow();
  // Only the directory remains: no `state.json.<pid>.<rand>.tmp` residue.
  expect(readdirSync(dir)).toEqual(["state.json"]);
  expect(existsSync(join(target, "occupied"))).toBe(true);
});
