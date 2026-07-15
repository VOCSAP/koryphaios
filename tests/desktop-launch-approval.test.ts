// PLAN C19: project launchCommand approval gate
// (desktop/src/main/launch-approval).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approve,
  commandHash,
  isApproved,
  readApprovals,
  resolveApprovedLaunchCommand
} from "../desktop/src/main/launch-approval.ts";

let dir: string;
const KEY = "github.com/acme/repo";
const PROJ_CMD = "malicious-or-not --flag";
const FALLBACK = "claude --dangerously-load-development-channels server:claude-peers";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-approve-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("first use prompts; approval persists the hash and skips the prompt next time", () => {
  const file = join(dir, "a.json");
  let prompts = 0;
  const r1 = resolveApprovedLaunchCommand({
    projectKey: KEY,
    projectCommand: PROJ_CMD,
    fallback: FALLBACK,
    approvalsFile: file,
    confirm: () => (prompts++, true)
  });
  expect(r1).toEqual({ command: PROJ_CMD, source: "project", prompted: true });
  expect(prompts).toBe(1);
  expect(readApprovals(file)[KEY]).toBe(commandHash(PROJ_CMD));

  const r2 = resolveApprovedLaunchCommand({
    projectKey: KEY,
    projectCommand: PROJ_CMD,
    fallback: FALLBACK,
    approvalsFile: file,
    confirm: () => (prompts++, true)
  });
  expect(r2.prompted).toBe(false);
  expect(r2.command).toBe(PROJ_CMD);
  expect(prompts).toBe(1); // not asked again
});

test("refusal falls back to the global command and persists NOTHING", () => {
  const file = join(dir, "b.json");
  const r = resolveApprovedLaunchCommand({
    projectKey: KEY,
    projectCommand: PROJ_CMD,
    fallback: FALLBACK,
    approvalsFile: file,
    confirm: () => false
  });
  expect(r).toEqual({ command: FALLBACK, source: "fallback", prompted: true });
  expect(readApprovals(file)).toEqual({});
  // Asked again on the next launch (no sticky refusal).
  let asked = false;
  resolveApprovedLaunchCommand({
    projectKey: KEY,
    projectCommand: PROJ_CMD,
    fallback: FALLBACK,
    approvalsFile: file,
    confirm: () => ((asked = true), false)
  });
  expect(asked).toBe(true);
});

test("a CHANGED project command (different hash) re-prompts", () => {
  const file = join(dir, "c.json");
  approve(file, KEY, PROJ_CMD);
  expect(isApproved(file, KEY, PROJ_CMD)).toBe(true);
  expect(isApproved(file, KEY, PROJ_CMD + " --extra")).toBe(false);

  let asked = false;
  const r = resolveApprovedLaunchCommand({
    projectKey: KEY,
    projectCommand: PROJ_CMD + " --extra",
    fallback: FALLBACK,
    approvalsFile: file,
    confirm: () => ((asked = true), false)
  });
  expect(asked).toBe(true);
  expect(r.command).toBe(FALLBACK);
  // The old approval is untouched (refusing the new one persists nothing).
  expect(readApprovals(file)[KEY]).toBe(commandHash(PROJ_CMD));
});

test("approvals are per project_key; malformed store degrades to empty", () => {
  const file = join(dir, "d.json");
  approve(file, "github.com/a/one", "cmd-one");
  expect(isApproved(file, "github.com/a/two", "cmd-one")).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf-8"))["github.com/a/one"]).toBe(commandHash("cmd-one"));

  const broken = join(dir, "broken.json");
  Bun.write(broken, "{not json");
  expect(readApprovals(broken)).toEqual({});
});
