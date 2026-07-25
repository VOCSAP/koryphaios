// PLAN-SANDBOX SBX2: per-project sandbox settings store (operator app-state,
// never a repo file) — desktop/src/main/sandbox-store.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectSandboxSettings,
  readSandboxStore,
  writeSandboxEnabled,
} from "../desktop/src/main/sandbox-store.ts";
import { DEFAULT_SANDBOX_PORTS, SANDBOX_IMAGE_DEFAULT } from "../desktop/src/main/sandbox-command.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-sandbox-store-"));
  file = join(dir, "sandbox.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("missing file yields defaults (disabled, default image/ports)", () => {
  const s = projectSandboxSettings(file, "local:abc");
  expect(s.enabled).toBe(false);
  expect(s.ports).toEqual(DEFAULT_SANDBOX_PORTS);
  expect(readSandboxStore(file).image).toBe(SANDBOX_IMAGE_DEFAULT);
});

test("enable/disable round-trips per project and keeps siblings", () => {
  writeSandboxEnabled(file, "local:aaa", true);
  writeSandboxEnabled(file, "local:bbb", false);
  expect(projectSandboxSettings(file, "local:aaa").enabled).toBe(true);
  expect(projectSandboxSettings(file, "local:bbb").enabled).toBe(false);
  writeSandboxEnabled(file, "local:aaa", false);
  expect(projectSandboxSettings(file, "local:aaa").enabled).toBe(false);
  expect(Object.keys(readSandboxStore(file).projects).sort()).toEqual([
    "local:aaa",
    "local:bbb",
  ]);
});

test("malformed file falls back to defaults instead of throwing", () => {
  writeFileSync(file, "{not json");
  expect(projectSandboxSettings(file, "k").enabled).toBe(false);
  // and a subsequent write recovers the file
  writeSandboxEnabled(file, "k", true);
  expect(projectSandboxSettings(file, "k").enabled).toBe(true);
});

test("hand-edited ports are sanitized (bounds, dedup, fallback)", () => {
  writeFileSync(
    file,
    JSON.stringify({
      image: "  custom-img  ",
      projects: { k: { enabled: true, ports: [3000, 3000, 0, 99999, "x"] } },
    })
  );
  const s = projectSandboxSettings(file, "k");
  expect(s.ports).toEqual([3000]);
  expect(readSandboxStore(file).image).toBe("custom-img");
  writeFileSync(file, JSON.stringify({ projects: { k: { enabled: true, ports: [] } } }));
  expect(projectSandboxSettings(file, "k").ports).toEqual(DEFAULT_SANDBOX_PORTS);
});
