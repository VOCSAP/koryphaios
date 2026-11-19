import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TRACED_FILES,
  MAX_TRACED_PER_SCAN,
  PROJECT_SOURCES,
  projectCreationPath,
  projectRootPath,
  sameWorkspaceRef,
  selectProjectFile,
  traceInvalidFileOnce,
  traceScan
} from "../desktop/src/main/project-files.ts";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "project-files-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function put(file: string, text = "{}"): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf-8");
}
const inNew = (project: string, name: string): string => join(project, ".claude", "koryphaios", name);
const inLegacy = (project: string, name: string): string => join(project, ".claude", "claude-peers", name);

test("a new project file is created under .claude/koryphaios", () => {
  const project = tmpProject();
  expect(projectCreationPath(project, "workspaces", "w.json")).toBe(join(project, ".claude", "koryphaios", "workspaces", "w.json"));
});

test("each source names its own folder under .claude", () => {
  const project = tmpProject();
  expect(projectRootPath(project, "koryphaios")).toBe(join(project, ".claude", "koryphaios"));
  expect(projectRootPath(project, "legacy")).toBe(join(project, ".claude", "claude-peers"));
  expect(PROJECT_SOURCES).toEqual(["koryphaios", "legacy"]);
});

test("two refs are the same workspace only when project, folder and id all agree, whatever the project spelling", () => {
  const project = tmpProject();
  const real = join(project, "real");
  mkdirSync(real);
  const link = join(project, "link");
  symlinkSync(real, link, "junction");
  const ref = { projectDir: real, id: "wsp_a", source: "koryphaios" as const };
  expect(sameWorkspaceRef(ref, { ...ref })).toBe(true);
  expect(sameWorkspaceRef(ref, { ...ref, projectDir: link }), "an alias of the project").toBe(true);
  expect(sameWorkspaceRef(ref, { ...ref, source: "legacy" }), "the other folder").toBe(false);
  expect(sameWorkspaceRef(ref, { ...ref, id: "wsp_b" }), "another id").toBe(false);
  expect(sameWorkspaceRef(ref, { ...ref, projectDir: project }), "another project").toBe(false);
});

test("the file under .claude/koryphaios is selected when both folders hold the file", () => {
  const project = tmpProject();
  put(inLegacy(project, "config.json"));
  put(inNew(project, "config.json"));
  expect(selectProjectFile(project, "config.json")).toEqual({ path: inNew(project, "config.json"), source: "koryphaios" });
});

test("the file under .claude/claude-peers is selected when it is the only one", () => {
  const project = tmpProject();
  put(inLegacy(project, "config.json"));
  expect(selectProjectFile(project, "config.json")).toEqual({ path: inLegacy(project, "config.json"), source: "legacy" });
});

test("a new folder without the file does not hide the file of the old folder", () => {
  const project = tmpProject();
  put(inNew(project, "serve.json"));
  put(inLegacy(project, "config.json"));
  expect(selectProjectFile(project, "config.json")).toEqual({ path: inLegacy(project, "config.json"), source: "legacy" });
});

test("nothing is selected when neither folder holds the file, even when .claude is not a folder", () => {
  const project = tmpProject();
  expect(selectProjectFile(project, "config.json")).toBeNull();
  put(join(project, ".claude"), "not a folder");
  expect(selectProjectFile(project, "config.json")).toBeNull();
});

test("the file is selected by existence, whatever its content", () => {
  const project = tmpProject();
  put(inNew(project, "config.json"), "{ not json");
  put(inLegacy(project, "config.json"), "{}");
  expect(selectProjectFile(project, "config.json")?.source).toBe("koryphaios");
});

test("a dangling link under .claude/koryphaios is selected, never skipped for the old folder's file", () => {
  const project = tmpProject();
  put(inLegacy(project, "config.json"));
  mkdirSync(join(inNew(project, "config.json"), ".."), { recursive: true });
  symlinkSync(join(project, "gone.json"), inNew(project, "config.json"), "file");
  expect(selectProjectFile(project, "config.json")).toEqual({ path: inNew(project, "config.json"), source: "koryphaios" });
});

test("a live link under .claude/koryphaios is selected like a plain file", () => {
  const project = tmpProject();
  put(join(project, "real.json"));
  put(inLegacy(project, "config.json"));
  mkdirSync(join(inNew(project, "config.json"), ".."), { recursive: true });
  symlinkSync(join(project, "real.json"), inNew(project, "config.json"), "file");
  expect(selectProjectFile(project, "config.json")?.source).toBe("koryphaios");
});

function setMtime(file: string, seconds: number): void {
  utimesSync(file, seconds, seconds);
}

test("an invalid file is traced once, and again when it is repaired then broken again", () => {
  const project = tmpProject();
  const file = inNew(project, "config.json");
  const reports: string[] = [];
  const report = (_scope: string, message: string): void => {
    reports.push(message);
  };
  put(file, "{ broken");
  setMtime(file, 1_000);
  traceInvalidFileOnce(file, new Error("bad"), report);
  traceInvalidFileOnce(file, new Error("bad"), report);
  expect(reports, "the same file and signature traces once").toHaveLength(1);
  expect(reports[0]).toContain(file);

  put(file, "{}");
  setMtime(file, 2_000);
  put(file, "{ broken");
  setMtime(file, 3_000);
  traceInvalidFileOnce(file, new Error("bad"), report);
  expect(reports, "a repaired then broken file traces again").toHaveLength(2);
});

test("two invalid files are traced separately", () => {
  const project = tmpProject();
  const first = inNew(project, "config.json");
  const second = inLegacy(project, "config.json");
  put(first, "{ broken");
  put(second, "{ broken");
  setMtime(first, 1_000);
  setMtime(second, 1_000);
  const reports: string[] = [];
  const report = (_scope: string, message: string): void => {
    reports.push(message);
  };
  traceInvalidFileOnce(first, new Error("bad"), report);
  traceInvalidFileOnce(second, new Error("bad"), report);
  expect(reports).toHaveLength(2);
});

test("two spellings of one invalid file trace once", () => {
  const project = tmpProject();
  const real = join(project, "real");
  mkdirSync(real);
  const link = join(project, "link");
  symlinkSync(real, link, "junction");
  const file = join(real, "config.json");
  put(file, "{ broken");
  setMtime(file, 1_000);
  const spellings = [file, join(link, "config.json"), join(real, ".", "config.json")];
  if (process.platform === "win32") spellings.push(join(real.toUpperCase(), "config.json"));
  const reports: string[] = [];
  const report = (_scope: string, message: string): void => {
    reports.push(message);
  };
  for (const spelling of spellings) traceInvalidFileOnce(spelling, new Error("bad"), report);
  expect(reports, `${spellings.length} spellings of one file`).toHaveLength(1);
});

function tracedFiles(project: string, count: number): string[] {
  const files: string[] = [];
  for (let index = 0; index < count; index++) {
    const file = join(project, `config-${index}.json`);
    put(file, "{ broken");
    setMtime(file, 1_000);
    files.push(file);
  }
  return files;
}

test("the traced files are bounded: the oldest is evicted first, and none at exactly the cap", () => {
  const files = tracedFiles(tmpProject(), MAX_TRACED_FILES + 1);
  const reports: string[] = [];
  const report = (_scope: string, message: string): void => {
    reports.push(message);
  };
  const trace = (file: string): void => traceInvalidFileOnce(file, new Error("bad"), report);
  for (const file of files.slice(0, MAX_TRACED_FILES)) trace(file);
  expect(reports).toHaveLength(MAX_TRACED_FILES);
  trace(files[0]!);
  expect(reports, "at the cap nothing is evicted").toHaveLength(MAX_TRACED_FILES);

  trace(files[MAX_TRACED_FILES]!);
  expect(reports).toHaveLength(MAX_TRACED_FILES + 1);
  trace(files[1]!);
  expect(reports, "the second oldest is still remembered").toHaveLength(MAX_TRACED_FILES + 1);
  trace(files[0]!);
  expect(reports, "the oldest was evicted and traces again").toHaveLength(MAX_TRACED_FILES + 2);
});

function scanReports(dir: string, files: string[]): string[] {
  const reports: string[] = [];
  const scan = traceScan(dir, (_scope, message) => {
    reports.push(message);
  });
  for (const file of files) scan.invalid(file, new Error("bad"));
  scan.done();
  return reports;
}

test("a scan traces the first invalid files one by one and the rest in one line for the folder", () => {
  const project = tmpProject();
  const files = tracedFiles(project, MAX_TRACED_PER_SCAN + 5);
  const reports = scanReports(project, files);
  expect(reports).toHaveLength(MAX_TRACED_PER_SCAN + 1);
  for (const file of files.slice(0, MAX_TRACED_PER_SCAN)) {
    expect(reports.filter((message) => message.includes(file))).toHaveLength(1);
  }
  expect(reports[MAX_TRACED_PER_SCAN]).toBe("5 more invalid files in " + project);
  for (const file of files.slice(MAX_TRACED_PER_SCAN)) {
    expect(reports.some((message) => message.includes(file)), "an overflowing file is not named").toBe(false);
  }
});

test("a scan of exactly the budget adds no summary line", () => {
  const project = tmpProject();
  expect(scanReports(project, tracedFiles(project, MAX_TRACED_PER_SCAN))).toHaveLength(MAX_TRACED_PER_SCAN);
});

test("a second scan of more invalid files than the cap traces nothing", () => {
  const project = tmpProject();
  const files = tracedFiles(project, MAX_TRACED_FILES + 1);
  expect(scanReports(project, files)).toHaveLength(MAX_TRACED_PER_SCAN + 1);
  expect(scanReports(project, files)).toEqual([]);
});

test("the summary is traced again when the overflowing files change, and only the summary", () => {
  const project = tmpProject();
  const files = tracedFiles(project, MAX_TRACED_PER_SCAN + 5);
  scanReports(project, files);
  for (const file of files.slice(MAX_TRACED_PER_SCAN)) {
    put(file, "{ broken, and longer than before");
    setMtime(file, 2_000);
  }
  expect(scanReports(project, files)).toEqual(["5 more invalid files in " + project]);
});
