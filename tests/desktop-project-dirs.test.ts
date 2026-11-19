import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_PROJECT_DIR_NAME,
  PROJECT_DIR_NAME,
  electEntry,
  electProjectEntry,
  projectEntryCandidates,
} from "../desktop/src/shared/project-dirs.ts";

const projects: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "project-dirs-test-"));
  projects.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(dir: string, folder: string, name: string, text = "{}"): string {
  mkdirSync(join(dir, ".claude", folder), { recursive: true });
  const file = join(dir, ".claude", folder, name);
  writeFileSync(file, text, "utf-8");
  return file;
}

test("the two folders are named koryphaios and claude-peers", () => {
  expect([PROJECT_DIR_NAME, LEGACY_PROJECT_DIR_NAME]).toEqual(["koryphaios", "claude-peers"]);
});

test("the candidates are the koryphaios entry then the claude-peers entry, with their relative path", () => {
  const dir = project();
  expect(projectEntryCandidates(dir, "rules.json")).toEqual([
    { path: join(dir, ".claude", "koryphaios", "rules.json"), rel: join(".claude", "koryphaios", "rules.json"), source: "koryphaios" },
    { path: join(dir, ".claude", "claude-peers", "rules.json"), rel: join(".claude", "claude-peers", "rules.json"), source: "legacy" },
  ]);
});

test("the koryphaios entry is elected when both exist", () => {
  const dir = project();
  put(dir, "claude-peers", "rules.json");
  const fresh = put(dir, "koryphaios", "rules.json");
  expect(electProjectEntry(dir, "rules.json")).toMatchObject({ path: fresh, source: "koryphaios" });
});

test("the claude-peers entry is elected when it is the only one", () => {
  const dir = project();
  const old = put(dir, "claude-peers", "rules.json");
  expect(electProjectEntry(dir, "rules.json")).toMatchObject({ path: old, source: "legacy" });
});

test("nothing is elected when neither entry exists, even when .claude is a file", () => {
  const dir = project();
  expect(electProjectEntry(dir, "rules.json")).toBeNull();
  writeFileSync(join(dir, ".claude"), "not a folder", "utf-8");
  expect(electProjectEntry(dir, "rules.json")).toBeNull();
});

test("a folder without the entry does not hide the entry of the other folder", () => {
  const dir = project();
  mkdirSync(join(dir, ".claude", "koryphaios"), { recursive: true });
  const old = put(dir, "claude-peers", "serve.json");
  expect(electProjectEntry(dir, "serve.json")).toMatchObject({ path: old, source: "legacy" });
});

test("a dangling symlink in the koryphaios folder is elected, not skipped for the claude-peers entry", () => {
  const dir = project();
  put(dir, "claude-peers", "rules.json");
  mkdirSync(join(dir, ".claude", "koryphaios"), { recursive: true });
  const link = join(dir, ".claude", "koryphaios", "rules.json");
  symlinkSync(join(dir, "nowhere.json"), link, "file");
  expect(electProjectEntry(dir, "rules.json")).toMatchObject({ path: link, source: "koryphaios" });
});

test("an entry that cannot be examined for another reason than absence is elected, absence is skipped", () => {
  const dir = project();
  const candidates = projectEntryCandidates(dir, "rules.json");
  const failWith = (code: string) => (): never => {
    throw Object.assign(new Error(code), { code });
  };
  expect(electEntry(candidates, failWith("EACCES"))).toMatchObject({ source: "koryphaios" });
  expect(electEntry(candidates, failWith("ELOOP"))).toMatchObject({ source: "koryphaios" });
  expect(electEntry(candidates, failWith("ENOENT"))).toBeNull();
  expect(electEntry(candidates, failWith("ENOTDIR"))).toBeNull();
});
