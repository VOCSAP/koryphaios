import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AVATAR_TRAY_ICON_DIRNAME, avatarTrayIconFiles } from "../desktop/src/main/avatar-tray-icon.ts";

const DESKTOP_DIR = join(import.meta.dir, "..", "desktop");
const YML_PATH = join(DESKTOP_DIR, "electron-builder.yml");

// Targets whose content is a closed set the app loads by name: a partial copy
// is as broken as an empty one, so presence of "some file" is not enough.
const EXACT_FILES: Record<string, string[]> = {
  [AVATAR_TRAY_ICON_DIRNAME]: avatarTrayIconFiles()
};

interface ResourceCheck {
  missing: string[];
  empty: string[];
  absent: string[];
  unexpected: string[];
}

const CLEAN: ResourceCheck = { missing: [], empty: [], absent: [], unexpected: [] };

// Hand-rolled on purpose: no YAML parser is a declared dependency of desktop/.
function parseExtraResourcesTargets(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^extraResources:\s*$/.test(l));
  if (startIdx === -1) return [];
  const targets: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const m = line.match(/^\s*-?\s*to:\s*(.+?)\s*$/);
    if (m) targets.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return targets;
}

function checkDir(dir: string, label: string, target: string, result: ResourceCheck): void {
  if (!existsSync(dir)) {
    result.missing.push(label);
    return;
  }
  const present = readdirSync(dir);
  if (present.length === 0) {
    result.empty.push(label);
    return;
  }
  const expected = EXACT_FILES[target];
  if (expected === undefined) return;
  for (const file of expected) if (!present.includes(file)) result.absent.push(`${label}/${file}`);
  for (const file of present) if (!expected.includes(file)) result.unexpected.push(`${label}/${file}`);
}

function checkPackagedResources(resourcesDir: string, targets: string[]): ResourceCheck {
  const result: ResourceCheck = { missing: [], empty: [], absent: [], unexpected: [] };
  for (const target of targets) checkDir(join(resourcesDir, target), target, target, result);
  return result;
}

interface ExtraResourceEntry {
  from: string;
  to: string;
}

function parseExtraResourcesEntries(yamlText: string): ExtraResourceEntry[] {
  const lines = yamlText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^extraResources:\s*$/.test(l));
  if (startIdx === -1) return [];
  const entries: ExtraResourceEntry[] = [];
  let current: Partial<ExtraResourceEntry> = {};
  const flush = () => {
    if (current.from && current.to) entries.push({ from: current.from, to: current.to });
    current = {};
  };
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    // A list item may open with `to:` as legally as with `from:`.
    if (/^\s*-\s/.test(line)) flush();
    const fromM = line.match(/^\s*-?\s*from:\s*(.+?)\s*$/);
    if (fromM) current.from = fromM[1].replace(/^["']|["']$/g, "");
    const toM = line.match(/^\s*-?\s*to:\s*(.+?)\s*$/);
    if (toM) current.to = toM[1].replace(/^["']|["']$/g, "");
  }
  flush();
  return entries;
}

function checkSourceEntries(desktopDir: string, entries: ExtraResourceEntry[]): ResourceCheck {
  const result: ResourceCheck = { missing: [], empty: [], absent: [], unexpected: [] };
  for (const entry of entries) checkDir(join(desktopDir, entry.from), entry.from, entry.to, result);
  return result;
}

test("electron-builder.yml declares at least the known extraResources entries", () => {
  const targets = parseExtraResourcesTargets(readFileSync(YML_PATH, "utf-8"));
  expect(targets).toEqual(
    expect.arrayContaining(["locales", "docs", "deck-plugin", "deck-lead-plugin", "sandbox", AVATAR_TRAY_ICON_DIRNAME])
  );
});

const PACKAGED_RESOURCES_DIR = join(DESKTOP_DIR, "dist", "win-unpacked", "resources");
const HAS_PACKAGED_TREE = existsSync(PACKAGED_RESOURCES_DIR);

// CI does not package: without a local tree this reports SKIP, never a vacuous pass.
test.skipIf(!HAS_PACKAGED_TREE)(
  "every extraResources target is complete under a packaged win-unpacked/resources (needs desktop/dist/win-unpacked/resources)",
  () => {
    const targets = parseExtraResourcesTargets(readFileSync(YML_PATH, "utf-8"));
    expect(targets.length).toBeGreaterThan(0);
    expect(checkPackagedResources(PACKAGED_RESOURCES_DIR, targets)).toEqual(CLEAN);
  }
);

test("every extraResources source directory is present and complete", () => {
  const entries = parseExtraResourcesEntries(readFileSync(YML_PATH, "utf-8"));
  expect(entries.length, "the parser read no extraResources entry from the yml").toBeGreaterThan(0);
  expect(checkSourceEntries(DESKTOP_DIR, entries)).toEqual(CLEAN);
});

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function scratch(prefix: string): string {
  tmpDir = mkdtempSync(join(tmpdir(), prefix));
  return tmpDir;
}

test("a packaged tree holding only app.asar reports every target missing", () => {
  const resourcesDir = join(scratch("kory-eb-resources-"), "resources");
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(join(resourcesDir, "app.asar"), "stub");

  const result = checkPackagedResources(resourcesDir, ["locales", "docs", "deck-plugin", "sandbox"]);
  expect(result.missing.sort()).toEqual(["deck-plugin", "docs", "locales", "sandbox"]);
  expect(result.empty).toEqual([]);
});

test("a packaged target dir that exists but is empty is reported empty", () => {
  const resourcesDir = join(scratch("kory-eb-resources-"), "resources");
  mkdirSync(join(resourcesDir, "locales"), { recursive: true });
  mkdirSync(join(resourcesDir, "docs"), { recursive: true });
  writeFileSync(join(resourcesDir, "docs", "index.md"), "stub");

  const result = checkPackagedResources(resourcesDir, ["locales", "docs"]);
  expect(result.missing).toEqual([]);
  expect(result.empty).toEqual(["locales"]);
});

test("a source entry whose from: points nowhere is reported missing", () => {
  const dir = scratch("kory-eb-source-");
  mkdirSync(join(dir, "locales"), { recursive: true });
  writeFileSync(join(dir, "locales", "fr.json"), "{}");

  const result = checkSourceEntries(dir, [
    { from: "locales", to: "locales" },
    { from: "resources/sandbox", to: "sandbox" }
  ]);
  expect(result.missing).toEqual(["resources/sandbox"]);
  expect(result.empty).toEqual([]);
});

test("a source entry whose from: dir is empty is reported empty", () => {
  const dir = scratch("kory-eb-source-");
  mkdirSync(join(dir, "deck-plugin"), { recursive: true });

  const result = checkSourceEntries(dir, [{ from: "deck-plugin", to: "deck-plugin" }]);
  expect(result.missing).toEqual([]);
  expect(result.empty).toEqual(["deck-plugin"]);
});

test("an avatar-tray dir short of one icon, or carrying a stale one, is reported file by file", () => {
  const expected = avatarTrayIconFiles();
  expect(expected.length).toBeGreaterThan(1);
  const [dropped, ...kept] = expected;
  const dir = scratch("kory-eb-avatar-");
  const from = join("resources", AVATAR_TRAY_ICON_DIRNAME);
  mkdirSync(join(dir, from), { recursive: true });
  for (const file of [...kept, "avatar.png"]) writeFileSync(join(dir, from, file), "png");

  const source = checkSourceEntries(dir, [{ from, to: AVATAR_TRAY_ICON_DIRNAME }]);
  expect(source.absent).toEqual([`${from}/${dropped}`]);
  expect(source.unexpected).toEqual([`${from}/avatar.png`]);

  const packaged = checkPackagedResources(join(dir, "resources"), [AVATAR_TRAY_ICON_DIRNAME]);
  expect(packaged.absent).toEqual([`${AVATAR_TRAY_ICON_DIRNAME}/${dropped}`]);
  expect(packaged.unexpected).toEqual([`${AVATAR_TRAY_ICON_DIRNAME}/avatar.png`]);
});

test("parseExtraResourcesEntries keeps both entries when one opens with to: and the next with from:", () => {
  const yaml = [
    "extraResources:",
    "  - to: locales",
    "    from: locales",
    "  - from: docs",
    "    to: docs",
    "files:",
    "  - out/**/*"
  ].join("\n");
  expect(parseExtraResourcesEntries(yaml)).toEqual([
    { from: "locales", to: "locales" },
    { from: "docs", to: "docs" }
  ]);
});

test("parseExtraResourcesEntries returns an empty list for a yml with no extraResources block", () => {
  expect(parseExtraResourcesEntries("appId: com.example.app\nfiles:\n  - out/**/*\n")).toEqual([]);
});
