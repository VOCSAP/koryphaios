import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  DELEGATION_POLICY_DEFAULTS,
  MAX_TASK_LABEL_CODE_POINTS,
  isDelegationTaskId,
  parseDelegationPolicyEnvironment,
  taskLabelFromText,
  validateDeadlineSec,
  validateDelegationPolicyValue,
  validateTaskLabel,
} from "../shared/delegated-task.ts";
import { canonicalConfigPath } from "../shared/canonical-config-path.ts";
import { canonicalPath } from "../desktop/src/main/worktree-service.ts";

describe("delegated task validation", () => {
  test("accepts policy boundaries and refuses values with a different runtime shape", () => {
    expect(validateDelegationPolicyValue("max_rearms", 0)).toEqual({ ok: true, value: 0 });
    expect(validateDelegationPolicyValue("max_rearms", 10)).toEqual({ ok: true, value: 10 });
    expect(validateDelegationPolicyValue("lead_silence_sec", 14).ok).toBeFalse();
    expect(validateDelegationPolicyValue("max_deadline_sec", 86_401).ok).toBeFalse();
    expect(validateDelegationPolicyValue("max_rearms", 1.5).ok).toBeFalse();
    expect(validateDelegationPolicyValue("max_rearms", Number.NaN).ok).toBeFalse();
    expect(validateDelegationPolicyValue("max_rearms", Infinity).ok).toBeFalse();
    expect(validateDelegationPolicyValue("max_rearms", true).ok).toBeFalse();
    expect(validateDelegationPolicyValue("max_rearms", "3").ok).toBeFalse();
  });

  test("parses only strict decimal environment values", () => {
    expect(parseDelegationPolicyEnvironment("max_rearms", "10")).toEqual({ ok: true, value: 10 });
    for (const value of ["", " 3", "3 ", "+3", "03", "3s", "1e2", "-1"]) {
      expect(parseDelegationPolicyEnvironment("max_rearms", value).ok).toBeFalse();
    }
  });

  test("bounds an explicit deadline by the task snapshot and rejects non-finite runtime values", () => {
    expect(validateDeadlineSec(14_400, DELEGATION_POLICY_DEFAULTS)).toEqual({ ok: true, value: 14_400 });
    for (const value of [14_401, 0, Number.NaN, Infinity, -Infinity, 1.5, true, "60"]) {
      expect(validateDeadlineSec(value, DELEGATION_POLICY_DEFAULTS).ok).toBeFalse();
    }
  });

  test("normalizes labels before the broker accepts them", () => {
    const long = "😀".repeat(MAX_TASK_LABEL_CODE_POINTS + 1);
    const label = taskLabelFromText(`  hello\n${long}  `);
    expect(Array.from(label)).toHaveLength(MAX_TASK_LABEL_CODE_POINTS);
    expect(label.endsWith("…")).toBeTrue();
    expect(validateTaskLabel(label)).toEqual({ ok: true, value: label });
    expect(validateTaskLabel("  hello").ok).toBeFalse();
    expect(validateTaskLabel("").ok).toBeFalse();
  });

  test("recognizes only RFC UUID task identifiers", () => {
    expect(isDelegationTaskId("d2719a9e-6fe9-46d4-aa7e-f920c69c4b30")).toBeTrue();
    expect(isDelegationTaskId("not-a-task")).toBeFalse();
  });
});

test("canonical config paths match Deck canonicalPath for existing symlinked files", () => {
  const root = mkdtempSync(join(tmpdir(), "delegation-config-path-"));
  try {
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link, "junction");
    const existing = join(link, "config.json");
    writeFileSync(existing, "{}");
    const separatorVariant = process.platform === "win32" ? existing.replaceAll("\\", "/") : existing;

    expect(canonicalConfigPath(separatorVariant)).toBe(canonicalPath(separatorVariant));
    expect(canonicalConfigPath(normalize(separatorVariant))).toBe(canonicalPath(normalize(separatorVariant)));

    const missing = join(link, "future", "config.json");
    expect(canonicalConfigPath(missing)).toBe(join(canonicalPath(link), "future", "config.json"));
    expect(canonicalConfigPath(missing).includes(`${sep}link${sep}`)).toBeFalse();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type WindowsAliasFixture = { root: string; existing: string; shortPath: string };

function createWindowsAliasFixture(): WindowsAliasFixture | null {
  if (process.platform !== "win32") return null;
  const root = mkdtempSync(join(tmpdir(), "delegation-short-path-"));
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link, "junction");
  const existing = join(link, "config.json");
  writeFileSync(existing, "{}");
  const shortPath = new TextDecoder().decode(
    Bun.spawnSync(["cmd.exe", "/d", "/c", `for %I in (${existing}) do @echo %~sI`]).stdout
  ).trim();
  if (!shortPath || !existsSync(shortPath) || !/(?:^|[\\/])[^\\/]*~\d+(?:[\\/]|$)/i.test(shortPath)) {
    rmSync(root, { recursive: true, force: true });
    return null;
  }
  return { root, existing, shortPath };
}

const windowsAliasFixture = createWindowsAliasFixture();
afterAll(() => {
  if (windowsAliasFixture) rmSync(windowsAliasFixture.root, { recursive: true, force: true });
});

test.skipIf(windowsAliasFixture === null)(
  windowsAliasFixture === null
    ? "Windows 8.3 alias unavailable on this volume"
    : "canonical config paths resolve an actual Windows 8.3 alias",
  () => {
    const { existing, shortPath } = windowsAliasFixture!;
    expect(existsSync(shortPath)).toBeTrue();
    expect(shortPath).toMatch(/(?:^|[\\/])[^\\/]*~\d+(?:[\\/]|$)/i);
    expect(realpathSync.native(shortPath)).toBe(realpathSync.native(existing));
    expect(canonicalConfigPath(shortPath)).toBe(canonicalPath(existing));
    expect(canonicalConfigPath(existing.toUpperCase())).toBe(canonicalPath(existing));
  }
);
