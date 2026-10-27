// Covers only the two pure sink functions the IPC and store layers each
// delegate to.
// The underlying service producing the six real reasons is already directly
// testable and pinned elsewhere; these two sinks alone remain unimportable
// under the default test resolution, since their modules pull in an Electron or
// aliased import that cannot resolve there.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractBracedBody } from "./_braced-body";
import {
  workspaceRestoreOrThrow,
  workspaceRestoreToastKeyFor,
  type WorkspaceRestoreQuietReason
} from "../desktop/src/shared/workspace-restore-outcome";
import type { WorkspaceRestoreResult } from "../desktop/src/shared/workspace-restore-outcome";
import * as workspaceRestoreOutcome from "../desktop/src/shared/workspace-restore-outcome";

// ----- workspaceRestoreOrThrow (main-process sink) -----

test("ok:true resolves to { applied: true }", () => {
  expect(workspaceRestoreOrThrow({ ok: true })).toEqual({ applied: true });
});

const quietReasons: WorkspaceRestoreQuietReason[] = [
  "missing",
  "empty",
  "locked",
  "shell-declined",
  "cwd-declined",
  "busy",
  "superseded"
];

test("every quiet reason resolves to { applied: false, reason } -- never throws", () => {
  for (const reason of quietReasons) {
    expect(workspaceRestoreOrThrow({ ok: false, reason })).toEqual({ applied: false, reason });
  }
});

test("lock-race throws, with an actionable message naming what happened", () => {
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "lock-race" })).toThrow(
    /before changing any session/
  );
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "lock-race" })).toThrow(
    /workspace picker/
  );
});

test("credential failures throw before any session is opened", () => {
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "credential-timed-out" })).toThrow(/Aucune session/);
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "credential-unavailable", cause: "mint-refused" })).toThrow(/credential Inbox/);
});

test("unattended throws, with an actionable message distinct from lock-race's", () => {
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "unattended" })).toThrow(
    /operator at the desktop app/
  );
  expect(() => workspaceRestoreOrThrow({ ok: false, reason: "unattended" })).not.toThrow(/already swapped/);
});

test("only non-quiet restore reasons throw", () => {
  const reasons: WorkspaceRestoreResult[] = [
    { ok: false, reason: "missing" },
    { ok: false, reason: "empty" },
    { ok: false, reason: "locked" },
    { ok: false, reason: "shell-declined" },
    { ok: false, reason: "cwd-declined" },
    { ok: false, reason: "busy" },
    { ok: false, reason: "superseded" },
    { ok: false, reason: "lock-race" },
    { ok: false, reason: "credential-timed-out" },
    { ok: false, reason: "credential-unavailable", cause: "mint-refused" },
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
  expect(threw).toEqual([false, false, false, false, false, false, false, true, true, true, true]);
});

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

test("'busy' and 'superseded' each show a distinct restore toast", () => {
  expect(workspaceRestoreToastKeyFor("busy")).toBe("toast.workspaceRestoreBusy");
  expect(workspaceRestoreToastKeyFor("superseded")).toBe("toast.workspaceRestoreSuperseded");
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
    null, // cwd-declined
    "toast.workspaceRestoreBusy", // busy
    "toast.workspaceRestoreSuperseded" // superseded
  ]);
});

test("an unrecognised reason value (bypassing the type system) resolves to null rather than a wrong toast", () => {
  const bogus = "something-new" as unknown as WorkspaceRestoreQuietReason;
  expect(workspaceRestoreToastKeyFor(bogus)).toBeNull();
});

const CREDENTIAL_PREFIX = /^Restauration annulée\. Aucune session de cette restauration n'a été ouverte ; le scope est inchangé\. /;

function thrownMessage(result: WorkspaceRestoreResult): string {
  try {
    workspaceRestoreOrThrow(result);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(result)} to throw`);
}

test("every credential failure message states that no session was opened and the scope is unchanged", () => {
  const messages = [
    thrownMessage({ ok: false, reason: "credential-timed-out" }),
    ...(["trust", "identity", "capability", "local-file", "mint-refused"] as const).map((cause) =>
      thrownMessage({ ok: false, reason: "credential-unavailable", cause })
    ),
  ];
  for (const message of messages) expect(message).toMatch(CREDENTIAL_PREFIX);
});

test("each credential refusal cause throws its own diagnosis and its own action, never another cause's", () => {
  const expectations = {
    trust: [/n'accepte pas l'identité opérateur/, /relation de confiance/],
    identity: [/illisible ou indisponible/, /Vérifiez sa configuration/],
    capability: [/ne fournit pas le credential Inbox requis/, /provenance Inbox/],
    "local-file": [/ne peut pas être installé localement/, /droits d'écriture/],
    "mint-refused": [/refusé la création du credential Inbox/, /Consultez le motif/],
  } as const;
  const causes = Object.keys(expectations) as Array<keyof typeof expectations>;
  const messages = new Map(causes.map((cause) => [cause, thrownMessage({ ok: false, reason: "credential-unavailable", cause })]));
  for (const cause of causes) {
    const message = messages.get(cause)!;
    for (const part of expectations[cause]) expect(message, `${cause} message`).toMatch(part);
    for (const other of causes.filter((c) => c !== cause)) {
      for (const part of expectations[other]) expect(message, `${cause} message must not carry ${other}'s wording`).not.toMatch(part);
    }
  }
});

test("an undeterminable restore target throws the operator's exact sentence after the common prefix", () => {
  const message = thrownMessage({ ok: false, reason: "credential-unavailable", cause: "invalid-target" });
  expect(message).toBe(
    "Restauration annulée. Aucune session de cette restauration n'a été ouverte ; le scope est inchangé. Le Deck n'a pas pu déterminer le groupe ou le projet de cette restauration. Consultez le Journal avant de réessayer."
  );
});

test("a credential timeout throws a message distinct from every refusal cause, naming the delay and the Journal", () => {
  const timeout = thrownMessage({ ok: false, reason: "credential-timed-out" });
  expect(timeout).toMatch(/délai prévu/);
  expect(timeout).toMatch(/Journal/);
  expect(timeout).toMatch(/révocation en attente/);
  for (const cause of ["trust", "identity", "capability", "local-file", "mint-refused"] as const) {
    expect(timeout).not.toBe(thrownMessage({ ok: false, reason: "credential-unavailable", cause }));
  }
});

test("workspace credential journal messages name every failure instead of String(result)", () => {
  const format = (workspaceRestoreOutcome as {
    workspaceCredentialFailureJournalMessage?: (result: { state: string; cause?: string }, rescopeWaitMs: number) => string;
  }).workspaceCredentialFailureJournalMessage;
  expect(format).toBeTypeOf("function");

  const failures = [
    [{ state: "credential-timed-out" }, "workspace credential timed out: delivery exceeded 5s"],
    [{ state: "credential-unavailable", cause: "trust" }, "workspace credential unavailable: operator trust not established or no longer current"],
    [{ state: "credential-unavailable", cause: "identity" }, "workspace credential unavailable: operator identity is unreadable or unavailable"],
    [{ state: "credential-unavailable", cause: "capability" }, "workspace credential unavailable: broker lacks Inbox credential capability"],
    [{ state: "credential-unavailable", cause: "local-file" }, "workspace credential unavailable: local Inbox credential file could not be installed"],
    [{ state: "credential-unavailable", cause: "mint-refused" }, "workspace credential unavailable: Inbox credential preparation or finalization did not complete"],
    [{ state: "credential-unavailable", cause: "busy" }, "workspace credential unavailable: another scope credential operation is already active"],
    [{ state: "credential-unavailable", cause: "closed" }, "workspace credential unavailable: scope was closed"],
    [{ state: "credential-unavailable", cause: "invalid-target" }, "workspace credential unavailable: missing group or project"]
  ] as const;

  for (const [failure, expected] of failures) {
    const message = format!(failure, 5_000);
    expect(message).toBe(expected);
    expect(message).not.toContain("Journal");
    expect(message).not.toContain("preceding");
  }

  expect(format!({ state: "credential-unavailable", cause: "mint-refused" }, 5_000)).not.toContain("broker refused");
  expect(format!({ state: "credential-unavailable", cause: "busy" }, 5_000)).not.toContain("broker");

  const refusalWithSecrets = {
    state: "credential-unavailable",
    cause: "trust",
    token: "secret-token-value",
    credential: "secret-credential-value"
  };
  const message = format!(refusalWithSecrets);
  expect(message).not.toContain(refusalWithSecrets.token);
  expect(message).not.toContain(refusalWithSecrets.credential);
});

test("credentialFailureReporter projects the technical Journal message into reportError", () => {
  const reporter = (workspaceRestoreOutcome as {
    credentialFailureReporter?: (report: (scope: string, message: string) => void, rescopeWaitMs: number) => (result: { state: string; cause?: string }) => void;
  }).credentialFailureReporter;
  expect(reporter).toBeTypeOf("function");

  const calls: Array<[string, string]> = [];
  reporter!((scope, message) => calls.push([scope, message]), 5_000)({ state: "credential-unavailable", cause: "invalid-target" });
  expect(calls).toEqual([["workspace-restore", "workspace credential unavailable: missing group or project"]]);
});

test("WorkspaceService wires credentialFailureReporter(reportError) for onCredentialFailure", () => {
  const source = readFileSync(resolve(import.meta.dir, "../desktop/src/main/index.ts"), "utf8");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const marker = "const workspaces = new WorkspaceService({";
  const body = (text: string): string => {
    const compiled = transpiler.transformSync(text);
    const start = compiled.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    return extractBracedBody(compiled, compiled.indexOf("{", start), true);
  };
  expect(body(source)).toContain("onCredentialFailure: credentialFailureReporter(reportError, RESCOPE_WAIT_MS)");
  expect(body(source.replace("  onCredentialFailure: credentialFailureReporter(reportError, RESCOPE_WAIT_MS),", "  // onCredentialFailure: credentialFailureReporter(reportError, RESCOPE_WAIT_MS),"))).not.toContain("onCredentialFailure: credentialFailureReporter(reportError, RESCOPE_WAIT_MS)");
  expect(source).toContain("import { credentialFailureReporter } from '../shared/workspace-restore-outcome'");
});
