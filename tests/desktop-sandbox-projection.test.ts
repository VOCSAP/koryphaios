// PLAN-SANDBOX M2: operator-config projection (allow-list, sandbox-overrides
// overlay, host-only hook detection) — desktop/src/main/sandbox-projection.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECTED_ENTRIES,
  describeProjection,
  detectHostOnlyHooks,
  planProjection,
  projectionHookWarnings,
  unknownOverrides,
} from "../desktop/src/main/sandbox-projection.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-sandbox-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("only allow-listed entries are projected — credentials never are", () => {
  writeFileSync(join(dir, "CLAUDE.md"), "# global");
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, ".credentials.json"), '{"token":"secret"}');
  mkdirSync(join(dir, "projects"));
  writeFileSync(join(dir, "settings.json"), "{}");

  const names = planProjection(dir).map((e) => e.name);
  expect(names.sort()).toEqual(["CLAUDE.md", "agents", "settings.json"]);
  expect(names).not.toContain(".credentials.json");
  expect(names).not.toContain("projects");
  // The allow-list is the contract: keep it explicit.
  expect(PROJECTED_ENTRIES).toContain("skills");
  expect(PROJECTED_ENTRIES).toContain("plugins");
});

test("sandbox-overrides entries win over the base copy", () => {
  writeFileSync(join(dir, "settings.json"), '{"hooks":{}}');
  writeFileSync(join(dir, "CLAUDE.md"), "base");
  mkdirSync(join(dir, "sandbox-overrides"));
  writeFileSync(join(dir, "sandbox-overrides", "settings.json"), '{"hooks":{}}');

  const entries = planProjection(dir);
  const settings = entries.find((e) => e.name === "settings.json")!;
  expect(settings.override).toBe(true);
  expect(settings.hostPath).toBe(join(dir, "sandbox-overrides", "settings.json"));
  expect(entries.find((e) => e.name === "CLAUDE.md")!.override).toBe(false);
  expect(describeProjection(entries)).toContain("settings.json (override)");
});

test("missing entries are skipped, not faked", () => {
  expect(planProjection(dir)).toEqual([]);
  expect(describeProjection([])).toBe("none");
  expect(planProjection(join(dir, "does-not-exist"))).toEqual([]);
});

test("detectHostOnlyHooks flags PowerShell / drive-letter / .ps1 commands", () => {
  const settings = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "powershell -File C:\\tools\\hook.ps1" }] },
        { hooks: [{ type: "command", command: "bun run hook.ts" }] }
      ],
      Stop: [{ hooks: [{ type: "command", command: "D:/scripts/notify.bat" }] }]
    }
  });
  const found = detectHostOnlyHooks(settings);
  expect(found.length).toBe(2);
  expect(found.some((f) => f.includes("powershell"))).toBe(true);
  expect(found.some((f) => f.includes("notify.bat"))).toBe(true);
  expect(found.some((f) => f.includes("bun run"))).toBe(false);
});

test("detectHostOnlyHooks tolerates malformed settings", () => {
  expect(detectHostOnlyHooks("{not json")).toEqual([]);
  expect(detectHostOnlyHooks("{}")).toEqual([]);
});

test("projectionHookWarnings reads the projected settings.json", () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "pwsh -c x" }] }] } })
  );
  expect(projectionHookWarnings(planProjection(dir))).toEqual(["pwsh -c x"]);
  expect(projectionHookWarnings([])).toEqual([]);
});

test("unknownOverrides surfaces overlay files that would silently do nothing", () => {
  mkdirSync(join(dir, "sandbox-overrides"));
  writeFileSync(join(dir, "sandbox-overrides", "settings.json"), "{}");
  writeFileSync(join(dir, "sandbox-overrides", "notes.md"), "x");
  expect(unknownOverrides(dir)).toEqual(["notes.md"]);
  expect(unknownOverrides(join(dir, "nope"))).toEqual([]);
});

test("a hook containing a URL is not flagged host-only (review finding #9)", () => {
  // `[A-Za-z]:[\\/]` unanchored also matches the `s:/` inside `https://`, so
  // every hook with a URL was reported as un-runnable in the container.
  expect(detectHostOnlyHooks(JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: "curl -s https://example.com/notify" }] }] }
  }))).toEqual([]);
  // A genuine Windows path is still caught.
  expect(detectHostOnlyHooks(JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: "node C:/tools/hook.js" }] }] }
  }))).toHaveLength(1);
});
