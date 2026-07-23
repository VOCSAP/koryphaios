// CT3: per-machine feature flags (desktop/src/main/launch-config resolveFeatures).
// The key rule: magicCompact reaches a PTY, so the GLOBAL config decides
// enablement and a project-local (clonable, hostile) config may only RESTRICT
// it to 'off'; handoff is advisory text and follows normal precedence.

import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFeatures,
  DEFAULT_FEATURES,
  localConfigPath,
  globalConfigDir
} from "../desktop/src/main/launch-config.ts";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "features-test-"));
  tmpDirs.push(d);
  return d;
}
/** An env whose global config dir points at a throwaway location. */
function envWithGlobal(): { env: NodeJS.ProcessEnv; dir: string } {
  const home = tmpProject();
  const env = { ...process.env, XDG_CONFIG_HOME: home, APPDATA: home } as NodeJS.ProcessEnv;
  return { env, dir: globalConfigDir(env) };
}
function writeJson(file: string, obj: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(obj), "utf-8");
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("defaults when no config is present", () => {
  const { env } = envWithGlobal();
  expect(resolveFeatures(tmpProject(), env)).toEqual(DEFAULT_FEATURES);
});

test("global config enables magicCompact and sets handoff", () => {
  const { env, dir } = envWithGlobal();
  writeJson(join(dir, "config.json"), { features: { magicCompact: "on", handoff: "kleos" } });
  expect(resolveFeatures(tmpProject(), env)).toEqual({ magicCompact: "on", handoff: "kleos" });
});

test("project-local config CANNOT enable magicCompact (global-only)", () => {
  const { env } = envWithGlobal(); // no global features -> default 'auto'
  const proj = tmpProject();
  writeJson(localConfigPath(proj), { features: { magicCompact: "on" } });
  // Local 'on' is ignored; the effective value stays the global default.
  expect(resolveFeatures(proj, env).magicCompact).toBe(DEFAULT_FEATURES.magicCompact);
});

test("project-local config MAY restrict magicCompact to off", () => {
  const { env, dir } = envWithGlobal();
  writeJson(join(dir, "config.json"), { features: { magicCompact: "on" } });
  const proj = tmpProject();
  writeJson(localConfigPath(proj), { features: { magicCompact: "off" } });
  expect(resolveFeatures(proj, env).magicCompact).toBe("off");
});

test("handoff follows normal precedence: local wins over global", () => {
  const { env, dir } = envWithGlobal();
  writeJson(join(dir, "config.json"), { features: { handoff: "file" } });
  const proj = tmpProject();
  writeJson(localConfigPath(proj), { features: { handoff: "kleos" } });
  expect(resolveFeatures(proj, env).handoff).toBe("kleos");
});

test("malformed flag values are ignored (fall back to defaults)", () => {
  const { env, dir } = envWithGlobal();
  writeJson(join(dir, "config.json"), { features: { magicCompact: "sometimes", handoff: 5 } });
  expect(resolveFeatures(tmpProject(), env)).toEqual(DEFAULT_FEATURES);
});
