// Covers only the two pure sink functions the IPC and store layers each
// delegate to.
// The underlying service producing the six real reasons is already directly
// testable and pinned elsewhere; these two sinks alone remain unimportable
// under the default test resolution, since their modules pull in an Electron or
// aliased import that cannot resolve there.

import { test, expect } from "bun:test";
import {
  workspaceRestoreOrThrow,
  workspaceRestoreToastKeyFor,
  type WorkspaceRestoreQuietReason
} from "../desktop/src/shared/workspace-restore-outcome";
import type { WorkspaceRestoreResult } from "../desktop/src/shared/workspace-restore-outcome";

// ----- workspaceRestoreOrThrow (main-process sink) -----

test("ok:true resolves to { applied: true }", () => {
  expect(workspaceRestoreOrThrow({ ok: true })).toEqual({ applied: true });
});

const quietReasons: WorkspaceRestoreQuietReason[] = [
  "missing",
  "empty",
  "locked",
  "shell-declined",
  "cwd-declined"
];

test("every quiet reason resolves to { applied: false, reason } -- never throws", () => {
  for (const reason of quietReasons) {
    expect(workspaceRestoreOrThrow({ ok: false, reason })).toEqual({ applied: false, reason });
  }
});

test("lock-race throws, with an actionable message naming what happened", () => {
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "lock-race" })).toThrow(
    /already swapped/
  );
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "lock-race" })).toThrow(
    /lock could not be reclaimed/
  );
});

// Card 64f8f629: unlike shell-declined/cwd-declined (the operator's own
// click, who already knows why), an unattended caller never got a chance to
// decide anything -- a quiet resolve here would read as an ordinary no-op
// restore instead of the blocked approval it actually is.
test("unattended throws, with an actionable message distinct from lock-race's", () => {
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "unattended" })).toThrow(
    /operator at the desktop app/
  );
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "unattended" })).not.toThrow(/already swapped/);
});

// Card 07134c6a, proof #1 (mirrors card 96c98453's own proof #1); extended by
// card 64f8f629 with 'unattended'. A mutation that reverts either fix --
// lock-race or unattended silently resolving instead of throwing -- must go
// RED. This pins the CURRENT, correct mapping: exactly two of seven reasons
// throw.
test("proof #1: exactly 'lock-race' and 'unattended' throw; the other five resolve", () => {
  const reasons: WorkspaceRestoreResult[] = [
    { ok: false, reason: "missing" },
    { ok: false, reason: "empty" },
    { ok: false, reason: "locked" },
    { ok: false, reason: "shell-declined" },
    { ok: false, reason: "cwd-declined" },
    { ok: false, reason: "lock-race" },
    { ok: false, reason: "unattended" }
  ];
  const threw = reasons.map((r) => {
    try {
      workspaceRestoreOrThrow(r);
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toEqual([false, false, false, false, false, true, true]);
});

// The switch's `default: { const _exhaustive: never = result.reason; ... }`
// is a compile-time guard (an 8th reason literal added to the union without
// a case fails `npm run typecheck:node`/`typecheck:web`, not this test) --
// this run-time case only documents the fallback shape for a value that
// bypasses the type system, it does not exercise the exhaustiveness check
// itself.
test("an unrecognised reason value (bypassing the type system) throws rather than silently resolving", () => {
  const bogus = { ok: false, reason: "something-new" } as unknown as WorkspaceRestoreResult;
  expect(() => workspaceRestoreOrThrow(bogus)).toThrow();
});

// ----- workspaceRestoreToastKeyFor (renderer sink) -----

test("'empty' shows toast.nothingToRestore", () => {
  expect(workspaceRestoreToastKeyFor("empty")).toBe("toast.nothingToRestore");
});

test("'locked' shows toast.alreadyOpen -- the existing wording fits it", () => {
  expect(workspaceRestoreToastKeyFor("locked")).toBe("toast.alreadyOpen");
});

// 'missing' gets its own toast.workspaceMissing, distinct from 'locked's
// toast.alreadyOpen: a workspace whose file is gone is not 'already open' --
// nothing is open at all.
test("'missing' shows its OWN toast.workspaceMissing -- distinct from 'locked's toast.alreadyOpen", () => {
  expect(workspaceRestoreToastKeyFor("missing")).toBe("toast.workspaceMissing");
  expect(workspaceRestoreToastKeyFor("missing")).not.toBe(workspaceRestoreToastKeyFor("locked"));
});

// An operator refusal (shell-declined / cwd-declined) shows no toast at all,
// distinct from 'locked' which shows toast.alreadyOpen.
test("proof #2: shell-declined and cwd-declined show NO toast -- distinct from 'locked', which shows toast.alreadyOpen", () => {
  expect(workspaceRestoreToastKeyFor("shell-declined")).toBeNull();
  expect(workspaceRestoreToastKeyFor("cwd-declined")).toBeNull();
  expect(workspaceRestoreToastKeyFor("locked")).toBe("toast.alreadyOpen");
  expect(workspaceRestoreToastKeyFor("shell-declined")).not.toBe(workspaceRestoreToastKeyFor("locked"));
  expect(workspaceRestoreToastKeyFor("cwd-declined")).not.toBe(workspaceRestoreToastKeyFor("locked"));
});

// A mutation that reverts store.ts's fix (every non-applied reason shows
// toast.alreadyOpen, today's bug) is pinned by the five-reason table below.
test("proof #1 mirror for the renderer sink: exactly the two declined reasons are silent, the rest show a toast", () => {
  const keys = quietReasons.map((r) => workspaceRestoreToastKeyFor(r));
  expect(keys).toEqual([
    "toast.workspaceMissing", // missing
    "toast.nothingToRestore", // empty
    "toast.alreadyOpen", // locked
    null, // shell-declined
    null // cwd-declined
  ]);
});

test("an unrecognised reason value (bypassing the type system) resolves to null rather than a wrong toast", () => {
  const bogus = "something-new" as unknown as WorkspaceRestoreQuietReason;
  expect(workspaceRestoreToastKeyFor(bogus)).toBeNull();
});
