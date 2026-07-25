// PLAN-SANDBOX SBX2 + M3: per-project sandbox settings store (operator
// app-state, never a repo file) — desktop/src/main/sandbox-store.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectSandboxSettings,
  readSandboxStore,
  writeSandboxImage,
  writeSandboxSettings,
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

test("missing file yields defaults (disabled, mount mode, default image/ports)", () => {
  const s = projectSandboxSettings(file, "local:abc");
  expect(s.enabled).toBe(false);
  expect(s.mode).toBe("mount");
  expect(s.ports).toEqual(DEFAULT_SANDBOX_PORTS);
  expect(s.copyIgnored).toEqual([]);
  expect(readSandboxStore(file).image).toBe(SANDBOX_IMAGE_DEFAULT);
});

test("patches round-trip per project and keep siblings", () => {
  writeSandboxSettings(file, "local:aaa", { enabled: true, mode: "copy" });
  writeSandboxSettings(file, "local:bbb", { enabled: false });
  const a = projectSandboxSettings(file, "local:aaa");
  expect(a.enabled).toBe(true);
  expect(a.mode).toBe("copy");
  expect(projectSandboxSettings(file, "local:bbb").enabled).toBe(false);
  // A later partial patch must not reset the untouched fields.
  writeSandboxSettings(file, "local:aaa", { enabled: false });
  expect(projectSandboxSettings(file, "local:aaa").mode).toBe("copy");
  expect(Object.keys(readSandboxStore(file).projects).sort()).toEqual(["local:aaa", "local:bbb"]);
});

test("malformed file falls back to defaults instead of throwing", () => {
  writeFileSync(file, "{not json");
  expect(projectSandboxSettings(file, "k").enabled).toBe(false);
  // and a subsequent write recovers the file
  writeSandboxSettings(file, "k", { enabled: true });
  expect(projectSandboxSettings(file, "k").enabled).toBe(true);
});

test("hand-edited values are sanitized (ports, mode, globs)", () => {
  writeFileSync(
    file,
    JSON.stringify({
      image: "  custom-img  ",
      projects: {
        k: {
          enabled: true,
          mode: "remote-lxc",
          ports: [3000, 3000, 0, 99999, "x"],
          copyIgnored: ["  PLAN-*.md  ", "", "PLAN-*.md", 42],
        },
      },
    })
  );
  const s = projectSandboxSettings(file, "k");
  expect(s.ports).toEqual([3000]);
  // An unknown work mode falls back to the safe one rather than reaching the
  // service as an unhandled branch.
  expect(s.mode).toBe("mount");
  expect(s.copyIgnored).toEqual(["PLAN-*.md"]);
  expect(readSandboxStore(file).image).toBe("custom-img");
  // An EXPLICITLY empty list stays empty — the defaults are shared by every
  // project, so clearing them is how a second sandboxed project avoids a
  // "port is already allocated" failure. Only an absent key means "defaults".
  writeFileSync(file, JSON.stringify({ projects: { k: { enabled: true, ports: [] } } }));
  expect(projectSandboxSettings(file, "k").ports).toEqual([]);
  writeFileSync(file, JSON.stringify({ projects: { k: { enabled: true } } }));
  expect(projectSandboxSettings(file, "k").ports).toEqual(DEFAULT_SANDBOX_PORTS);
});

test("image write is global and falls back to the default when blanked", () => {
  expect(writeSandboxImage(file, "my-image")).toBe("my-image");
  expect(readSandboxStore(file).image).toBe("my-image");
  expect(writeSandboxImage(file, "   ")).toBe(SANDBOX_IMAGE_DEFAULT);
});
