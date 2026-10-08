import { test, expect, describe, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { startBroker, stopBroker, post, approvalListBody, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  deriveTokenId,
  generateCredential,
} from "../shared/approval.ts";
import type { Approval } from "../shared/types.ts";
import type { PermissionLeaseReader } from "../desktop/hooks/permission-lease.ts";
import type { PermissionTranscriptContext, PermissionTranscriptObserver } from "../desktop/hooks/permission-transcript.ts";
import { encodePermissionLeaseDescriptor } from "../desktop/shared/permission-lease.ts";
import {
  buildApprovalRequest,
  classifyPayload,
  hasUnsafePermissionRepresentation,
  loadConfig,
  parseHookPayload,
  PERMISSION_BUDGET_MS,
  servePermission,
  summarizeToolInput,
  WITHDRAW_GRACE_SEC,
  type ApprovalHookConfig,
} from "../desktop/hooks/approval-hook.ts";

const brokers: TestBroker[] = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const b of brokers) await stopBroker(b);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// --- Pure helpers ---

describe("payload parsing", () => {
  test("malformed or empty stdin degrades to {} instead of throwing", () => {
    expect(parseHookPayload("")).toEqual({});
    expect(parseHookPayload("not json")).toEqual({});
    expect(parseHookPayload("null")).toEqual({});
    expect(parseHookPayload("[1,2]")).toEqual([1, 2] as never);
  });

  test("a real PermissionRequest payload parses", () => {
    const p = parseHookPayload(
      JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/build" },
      })
    );
    expect(p.tool_name).toBe("Bash");
  });
});

describe("event classification", () => {
  test("PermissionRequest yields a permission approval", () => {
    expect(classifyPayload({ hook_event_name: "PermissionRequest" })).toBe("permission");
  });

  test("Notification yields a question for agent_needs_input", () => {
    expect(
      classifyPayload({ hook_event_name: "Notification", notification_type: "agent_needs_input" })
    ).toBe("question");
  });

  test("idle_prompt is skipped — the CLI emits it only when NO dialog is on screen", () => {
    expect(
      classifyPayload({ hook_event_name: "Notification", notification_type: "idle_prompt" })
    ).toBe("skip");

    expect(
      classifyPayload({
        hook_event_name: "Notification",
        notification_type: "a_type_this_cli_does_not_emit_yet"
      })
    ).toBe("skip");
  });

  test("permission_prompt is skipped — PermissionRequest already owns it", () => {
    // Otherwise one dialog would raise two phone notifications.
    expect(
      classifyPayload({ hook_event_name: "Notification", notification_type: "permission_prompt" })
    ).toBe("skip");
  });

  test("unrelated events are skipped", () => {
    expect(classifyPayload({ hook_event_name: "PreToolUse" })).toBe("skip");
    expect(classifyPayload({})).toBe("skip");
    expect(
      classifyPayload({ hook_event_name: "Notification", notification_type: "auth_success" })
    ).toBe("skip");
  });
});

describe("tool summary", () => {
  test("prefers the command, then paths, then the url", () => {
    expect(summarizeToolInput("Bash", { command: "npm test" })).toBe("Bash: npm test");
    expect(summarizeToolInput("Edit", { file_path: "/a/b.ts" })).toBe("Edit: /a/b.ts");
    expect(summarizeToolInput("WebFetch", { url: "https://x.dev" })).toBe("WebFetch: https://x.dev");
  });

  test("degrades to the tool name alone", () => {
    expect(summarizeToolInput("Glob", {})).toBe("Glob");
    expect(summarizeToolInput("", undefined)).toBe("tool");
  });

  test("control characters from tool input never reach the title", () => {
    const s = summarizeToolInput("Bash", { command: "echo \x1b[31mhi\x07" });
    expect(s).not.toContain("\x1b");
    expect(s).not.toContain("\x07");
  });
});

describe("config gate", () => {
  test("no path means the feature is off (silent no-op)", () => {
    expect(loadConfig(undefined)).toBeNull();
    expect(loadConfig("")).toBeNull();
  });

  test("an unreadable file is not an error, just 'off'", () => {
    expect(loadConfig("/nonexistent/approval.json")).toBeNull();
  });

  test("an incomplete credential is refused", () => {
    const read = (): string => JSON.stringify({ brokerUrl: "http://x", operatorId: "a" });
    expect(loadConfig("/x", read as never)).toBeNull();
  });

  test("a complete credential loads with defaults", () => {
    const read = (): string =>
      JSON.stringify({
        brokerUrl: "http://x",
        operatorId: "op",
        tokenId: "tok",
        privateKey: "priv",
        publicKey: "pub",
      });
    const cfg = loadConfig("/x", read as never);
    expect(cfg?.blockSec).toBe(900);
    expect(cfg?.sessionRef).toBe("");
  });
});

test("a transcript result during wait withdraws the producer row without a late read or verdict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-approval-transcript-"));
  tmpDirs.push(dir);
  const transcriptPath = join(dir, "main.jsonl");
  const requestInput = { command: "rm -rf build" };
  writeFileSync(
    transcriptPath,
    [
      { uuid: "prompt", promptId: "prompt-1" },
      { uuid: "tool", parentUuid: "prompt", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: requestInput }] } },
    ].map((entry) => `${JSON.stringify(entry)}\n`).join("")
  );
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const calls: Array<{ op: string; request: Record<string, unknown>; signal: AbortSignal | undefined }> = [];
  const decisions: string[] = [];
  let startedWaiting: () => void = () => {};
  const waitStarted = new Promise<void>((resolve) => {
    startedWaiting = resolve;
  });
  const runClient = async (
    op: string,
    rawRequest: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal
  ) => {
    calls.push({ op, request: JSON.parse(rawRequest) as Record<string, unknown>, signal });
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: false as const, error: "HTTP 409: already answered" };
    startedWaiting();
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: true as const, pending: true };
  };

  const served = servePermission(
    cfg,
    { kind: "permission" },
    "tile-1",
    {
      runClient,
      writeDecision: (decision) => decisions.push(decision),
      transcript: { transcriptPath, promptId: "prompt-1", toolName: "Bash", toolInput: requestInput },
    }
  );
  await waitStarted;
  writeFileSync(
    transcriptPath,
    [
      { uuid: "prompt", promptId: "prompt-1" },
      { uuid: "tool", parentUuid: "prompt", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: requestInput }] } },
      { uuid: "result", parentUuid: "tool", message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] } },
    ].map((entry) => `${JSON.stringify(entry)}\n`).join("")
  );
  await served;

  expect(calls.map((call) => call.op)).toEqual(["add", "wait", "withdraw"]);
  expect(calls[2]?.request).toEqual({ id: "approval-1", producer_secret: "secret-1" });
  expect(calls[2]?.signal?.aborted).toBe(false);
  expect(decisions).toEqual([]);
});

test("a transcript result during add withdraws after delivery without starting a wait", async () => {
  const result = new AbortController();
  const requestInput = { file_path: "/repo/a.ts", content: "new" };
  const context: PermissionTranscriptContext = {
    transcriptPath: "/virtual/transcript.jsonl",
    promptId: "prompt-1",
    toolName: "Write",
    toolInput: requestInput,
  };
  const observer: PermissionTranscriptObserver = {
    acquired: Promise.resolve(),
    finished: new Promise(() => {}),
    resultSignal: result.signal,
    toolUseId: "tool-1",
    dispose: () => {},
  };
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const calls: string[] = [];
  let releaseAdd: () => void = () => {};
  let added: () => void = () => {};
  const addPending = new Promise<void>((resolve) => {
    releaseAdd = resolve;
  });
  const addStarted = new Promise<void>((resolve) => {
    added = resolve;
  });
  const runClient = async (op: string) => {
    calls.push(op);
    if (op === "add") {
      added();
      await addPending;
      return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    }
    return { ok: false as const, error: "HTTP 409: already answered" };
  };

  const served = servePermission(
    cfg,
    { kind: "permission" },
    "tile-1",
    {
      runClient,
      writeDecision: () => {
        throw new Error("a transcript result must not emit a verdict");
      },
      transcript: context,
      observeTranscript: () => observer,
    }
  );
  await addStarted;
  result.abort();
  releaseAdd();
  await served;

  expect(calls).toEqual(["add", "withdraw"]);
});

test("a refused withdraw reads one late valid verdict without the expired budget", async () => {
  const calls: Array<{ op: string; request: Record<string, unknown>; signal: AbortSignal | undefined }> = [];
  const decisions: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    rawRequest: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal
  ) => {
    const request = JSON.parse(rawRequest) as Record<string, unknown>;
    calls.push({ op, request, signal });
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: false as const, error: "HTTP 409: already answered" };
    return {
      ok: true as const,
      approval: { id: "approval-1", reply_route: "hook", status: "answered", answer_kind: "allow" },
    };
  };

  await servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 0, runClient, writeDecision: (decision) => decisions.push(decision) }
  );

  expect(calls.map((call) => call.op)).toEqual(["add", "withdraw", "wait"]);
  expect(calls[0]?.signal).toBeUndefined();
  expect(calls[1]?.signal).toBeUndefined();
  expect(calls[2]).toMatchObject({
    request: { id: "approval-1", producer_secret: "secret-1", timeout_sec: 20 },
    signal: undefined,
  });
  expect(decisions).toEqual(["allow"]);
});

test("a late wait stops when the transcript reports its result", async () => {
  const result = new AbortController();
  const context: PermissionTranscriptContext = {
    transcriptPath: "/virtual/transcript.jsonl",
    promptId: "prompt-1",
    toolName: "Bash",
    toolInput: { command: "echo ready" },
  };
  const observer: PermissionTranscriptObserver = {
    acquired: Promise.resolve(),
    finished: new Promise(() => {}),
    resultSignal: result.signal,
    toolUseId: "tool-1",
    dispose: () => {},
  };
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  let waiting: () => void = () => {};
  const lateWaitStarted = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let lateSignal: AbortSignal | undefined;
  const runClient = async (
    op: string,
    _rawRequest: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal
  ) => {
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: false as const, error: "HTTP 409: already answered" };
    lateSignal = signal;
    waiting();
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: true as const, pending: true };
  };

  const served = servePermission(
    cfg,
    { kind: "permission" },
    "tile-1",
    { budgetMs: 0, runClient, transcript: context, observeTranscript: () => observer }
  );
  await lateWaitStarted;
  result.abort();
  await Promise.race([
    served,
    Bun.sleep(1_000).then(() => {
      throw new Error("late transcript wait did not abort");
    }),
  ]);

  expect(lateSignal?.aborted).toBe(true);
});

test("a late read ignores verdicts for a different id, route or status", async () => {
  const invalidApprovals = [
    { id: "another", reply_route: "hook", status: "answered", answer_kind: "allow" },
    { id: "approval-1", reply_route: "pty", status: "answered", answer_kind: "allow" },
    { id: "approval-1", reply_route: "hook", status: "abandoned", answer_kind: "allow" },
  ];
  for (const approval of invalidApprovals) {
    const decisions: string[] = [];
    const cfg = {
      brokerUrl: "http://broker.test",
      brokerToken: null,
      operatorId: "op",
      tokenId: "tok",
      sessionRef: "window-1",
      privateKey: "private",
      publicKey: "public",
      osUserHash: "",
      blockSec: 900,
      origin: {},
    } satisfies ApprovalHookConfig;
    const runClient = async (op: string) => {
      if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
      if (op === "withdraw") return { ok: false as const, error: "HTTP 409: already answered" };
      return { ok: true as const, approval };
    };

    await servePermission(
      cfg,
      { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
      "tile-1",
      { budgetMs: 0, runClient, writeDecision: (decision) => decisions.push(decision) }
    );

    expect(decisions).toEqual([]);
  }
});

test("a permission lease must advance before delivery is added", async () => {
  let admit: (value: boolean) => void = () => {};
  const admission = new Promise<boolean>((resolve) => {
    admit = resolve;
  });
  const controller = new AbortController();
  const lease = {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    waitForAdmission: () => admission,
    dispose: () => {},
  } satisfies PermissionLeaseReader;
  const calls: string[] = [];
  const decisions: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (op: string) => {
    calls.push(op);
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    return { ok: true as const, approval: { id: "approval-1", reply_route: "hook", status: "answered", answer_kind: "allow" } };
  };

  const served = servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 1_000, lease, runClient, writeDecision: (decision) => decisions.push(decision) }
  );
  await Promise.resolve();
  expect(calls).toEqual([]);

  admit(true);
  await served;
  expect(calls).toEqual(["add", "wait"]);
  expect(decisions).toEqual(["allow"]);
});

test("a refused permission lease leaves the native decision untouched", async () => {
  const controller = new AbortController();
  const lease = {
    signal: controller.signal,
    isActive: () => false,
    waitForAdmission: async () => false,
    dispose: () => {},
  } satisfies PermissionLeaseReader;
  const calls: string[] = [];
  const decisions: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;

  await servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    {
      lease,
      runClient: async (op) => {
        calls.push(op);
        return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
      },
      writeDecision: (decision) => decisions.push(decision),
    }
  );

  expect(calls).toEqual([]);
  expect(decisions).toEqual([]);
});

test("a lost permission lease withdraws without emitting a late verdict", async () => {
  const controller = new AbortController();
  const lease = {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    waitForAdmission: async () => true,
    dispose: () => {},
  } satisfies PermissionLeaseReader;
  const calls: Array<{ op: string; signal: AbortSignal | undefined }> = [];
  let startedWaiting: () => void = () => {};
  const waitStarted = new Promise<void>((resolve) => {
    startedWaiting = resolve;
  });
  const decisions: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    _request: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal
  ) => {
    calls.push({ op, signal });
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: false as const, error: "HTTP 409: already answered" };
    startedWaiting();
    await Promise.race([
      new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
      Bun.sleep(50),
    ]);
    return {
      ok: true as const,
      approval: { id: "approval-1", reply_route: "hook", status: "answered", answer_kind: "allow" },
    };
  };

  const served = servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 1_000, lease, runClient, writeDecision: (decision) => decisions.push(decision) }
  );
  await waitStarted;
  controller.abort();
  await served;

  expect(calls.map((call) => call.op)).toEqual(["add", "wait", "withdraw"]);
  expect(calls[2]?.signal?.aborted).toBe(false);
  expect(decisions).toEqual([]);
});

test("a lost lease during normal withdrawal retries within the lease budget", async () => {
  const controller = new AbortController();
  const lease = {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    waitForAdmission: async () => true,
    dispose: () => {},
  } satisfies PermissionLeaseReader;
  const calls: Array<{ op: string; signal: AbortSignal | undefined }> = [];
  let startedWithdrawal: () => void = () => {};
  const withdrawalStarted = new Promise<void>((resolve) => {
    startedWithdrawal = resolve;
  });
  let retryElapsedMs = 0;
  let retryTimedOut = false;
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    _request: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal
  ) => {
    calls.push({ op, signal });
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "wait") return { ok: false as const, error: "broker unavailable" };
    const withdrawalCount = calls.filter((call) => call.op === "withdraw").length;
    if (withdrawalCount === 1) {
      startedWithdrawal();
      await Promise.race([
        new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
        Bun.sleep(50),
      ]);
    }
    if (withdrawalCount === 2) {
      const startedAt = performance.now();
      await Promise.race([
        new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
        Bun.sleep(3_000).then(() => {
          retryTimedOut = true;
        }),
      ]);
      retryElapsedMs = performance.now() - startedAt;
    }
    return { ok: true as const };
  };

  const served = servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 1_000, lease, runClient, writeDecision: () => {} }
  );
  await withdrawalStarted;
  controller.abort();
  await served;

  expect(calls.map((call) => call.op)).toEqual(["add", "wait", "withdraw", "withdraw"]);
  expect(calls[3]?.signal?.aborted).toBe(true);
  expect(retryTimedOut).toBe(false);
  expect(retryElapsedMs).toBeGreaterThanOrEqual(1_500);
  expect(retryElapsedMs).toBeLessThan(3_000);
});

test("a lost lease during error cleanup retries withdrawal without a verdict", async () => {
  const controller = new AbortController();
  const lease = {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    waitForAdmission: async () => true,
    dispose: () => {},
  } satisfies PermissionLeaseReader;
  const calls: Array<{ op: string; signal: AbortSignal | undefined }> = [];
  let startedWithdrawal: () => void = () => {};
  const withdrawalStarted = new Promise<void>((resolve) => {
    startedWithdrawal = resolve;
  });
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    _request: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal
  ) => {
    calls.push({ op, signal });
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "wait") {
      return {
        ok: true as const,
        approval: { id: "approval-1", reply_route: "hook", status: "answered", answer_kind: "allow" },
      };
    }
    if (calls.filter((call) => call.op === "withdraw").length === 1) {
      startedWithdrawal();
      await Promise.race([
        new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
        Bun.sleep(50),
      ]);
    }
    return { ok: true as const };
  };

  const served = servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 1_000, lease, runClient, writeDecision: () => { throw new Error("decision sink failed"); } }
  );
  await withdrawalStarted;
  controller.abort();
  await served;

  expect(calls.map((call) => call.op)).toEqual(["add", "wait", "withdraw", "withdraw"]);
  expect(calls[3]?.signal?.aborted).toBe(false);
});

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

describe("hasUnsafePermissionRepresentation", () => {
  const safe = { hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: "C:/a", tool_input: { command: "ls" } };

  test("a clean payload is safe", () => {
    expect(hasUnsafePermissionRepresentation(safe)).toBe(false);
  });

  test("a non-string cwd or tool name is unsafe", () => {
    expect(hasUnsafePermissionRepresentation({ ...safe, cwd: ["C:/a"] as never })).toBe(true);
    expect(hasUnsafePermissionRepresentation({ ...safe, tool_name: ["Bash"] as never })).toBe(true);
    expect(hasUnsafePermissionRepresentation({ ...safe, cwd: 5 as never })).toBe(true);
  });

  test("an agent type rejects every non-string boundary value", () => {
    for (const agentType of [{}, 5, true, null, Number.NaN]) {
      expect(hasUnsafePermissionRepresentation({ ...safe, agent_type: agentType as never })).toBe(true);
    }
  });

  test("an empty or whitespace agent type behaves as absent", () => {
    for (const agentType of ["", "   "]) {
      expect(hasUnsafePermissionRepresentation({ ...safe, agent_type: agentType })).toBe(false);
      expect(buildApprovalRequest({ ...safe, agent_type: agentType }, { brokerUrl: "http://x" } as ApprovalHookConfig).title).toBe("Bash: ls");
    }
  });

  test("a line break or tab is unsafe in the tool name, cwd, and agent type but legitimate in a tool input value", () => {
    expect(hasUnsafePermissionRepresentation({ ...safe, tool_name: "Bash\nAllow" })).toBe(true);
    expect(hasUnsafePermissionRepresentation({ ...safe, cwd: "C:/a\tb" })).toBe(true);
    expect(hasUnsafePermissionRepresentation({ ...safe, agent_type: "general-purpose\nAllow" })).toBe(true);
    expect(hasUnsafePermissionRepresentation({ ...safe, agent_type: `general-purpose${String.fromCodePoint(0x202e)}` })).toBe(true);
    expect(hasUnsafePermissionRepresentation({ ...safe, tool_input: { command: "a\n\tb" } })).toBe(false);
  });
});

test("a non-conflict withdraw failure does not start a late read and is traced", async () => {
  const calls: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (op: string) => {
    calls.push(op);
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: false as const, error: "broker unreachable" };
    return { ok: true as const, pending: true };
  };

  const { stderr } = await captureStderr(() =>
    servePermission(
      cfg,
      { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
      "tile-1",
      { budgetMs: 0, runClient, writeDecision: () => {} }
    )
  );

  expect(calls).toEqual(["add", "withdraw"]);
  expect(stderr).toContain("permission withdraw failed: broker unreachable");
});

test("a failed late read after a conflicting withdraw is traced", async () => {
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const calls: string[] = [];
  const runClient = async (op: string) => {
    calls.push(op);
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: false as const, error: "HTTP 409: already answered" };
    return { ok: false as const, error: "late read unreachable" };
  };

  const { stderr } = await captureStderr(() =>
    servePermission(
      cfg,
      { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
      "tile-1",
      { budgetMs: 0, runClient, writeDecision: () => {} }
    )
  );

  expect(calls).toEqual(["add", "withdraw", "wait"]);
  expect(stderr).toContain("permission late read failed: late read unreachable");
});

test("wait fallbacks leave the native permission dialog in control", async () => {
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const fallbacks = [
    { ok: false as const, error: "broker unreachable" },
    { ok: true as const, approval: { id: "approval-1", reply_route: "hook", status: "abandoned" } },
    { ok: true as const, approval: { id: "another", reply_route: "hook", status: "answered", answer_kind: "allow" } },
    { ok: true as const, approval: { id: "approval-1", reply_route: "pty", status: "answered", answer_kind: "allow" } },
  ];
  for (const fallback of fallbacks) {
    const calls: string[] = [];
    const decisions: string[] = [];
    const runClient = async (op: string) => {
      calls.push(op);
      if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
      if (op === "withdraw") return { ok: true as const, approval: { id: "approval-1", status: "answered_terminal" } };
      return fallback;
    };

    await servePermission(
      cfg,
      { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
      "tile-1",
      { budgetMs: 1_000, runClient, writeDecision: (decision) => decisions.push(decision) }
    );

    expect(calls).toEqual(["add", "wait", "withdraw"]);
    expect(decisions).toEqual([]);
  }
});

test("an expired local budget leaves the native permission dialog in control", async () => {
  const calls: string[] = [];
  const decisions: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (op: string) => {
    calls.push(op);
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    return { ok: true as const, approval: { id: "approval-1", status: "answered_terminal" } };
  };

  await servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 0, runClient, writeDecision: (decision) => decisions.push(decision) }
  );

  expect(calls).toEqual(["add", "withdraw"]);
  expect(decisions).toEqual([]);
});

test("the local approval deadline does not create a long-lived abort signal", async () => {
  const calls: Array<{ op: string; signal: AbortSignal | undefined }> = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    _rawRequest: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    signal?: AbortSignal
  ) => {
    calls.push({ op, signal });
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: true as const, approval: { id: "approval-1", status: "answered_terminal" } };
    const until = performance.now() + 30;
    while (performance.now() < until) {}
    return { ok: true as const, pending: true };
  };

  await servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 10, runClient, writeDecision: () => {} }
  );

  expect(calls.map(({ op }) => op)).toEqual(["add", "wait", "withdraw"]);
  expect(calls[1]?.signal).toBeUndefined();
});

test("session authentication errors stop polling without a verdict", async () => {
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;

  for (const error of ["HTTP 401: session token expired", "HTTP 403: session token revoked"]) {
    const calls: string[] = [];
    const decisions: string[] = [];
    const runClient = async (op: string) => {
      calls.push(op);
      if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
      if (op === "wait" && calls.length === 2) return { ok: false as const, error };
      if (op === "withdraw") return { ok: false as const, error: "HTTP 409: already answered" };
      return {
        ok: true as const,
        approval: { id: "approval-1", reply_route: "hook", status: "answered", answer_kind: "allow" },
      };
    };

    await servePermission(
      cfg,
      { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
      "tile-1",
      { budgetMs: 1_000, runClient, writeDecision: (decision) => decisions.push(decision) }
    );

    expect(calls).toEqual(["add", "wait", "withdraw"]);
    expect(decisions).toEqual([]);
  }
});

test("an expired local budget is traced separately from broker unreachability", async () => {
  const calls: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    _rawRequest: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    _signal?: AbortSignal
  ) => {
    calls.push(op);
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: true as const, approval: { id: "approval-1", status: "answered_terminal" } };
    const until = performance.now() + 50;
    while (performance.now() < until) {}
    return { ok: false as const, error: "broker unreachable: The operation timed out." };
  };

  const { stderr } = await captureStderr(() =>
    servePermission(
      cfg,
      { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
      "tile-1",
      { budgetMs: 30, runClient, writeDecision: () => {} }
    )
  );

  expect(calls).toEqual(["add", "wait", "withdraw"]);
  expect(stderr).toContain("permission wait budget expired: broker unreachable: The operation timed out.");
  expect(stderr).not.toContain("permission wait failed");
});

test("a wait failure after the deadline is traced as budget expiry", async () => {
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    _rawRequest: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    _signal?: AbortSignal
  ) => {
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    if (op === "withdraw") return { ok: true as const, approval: { id: "approval-1", status: "answered_terminal" } };
    const deadline = performance.now() + 30;
    while (performance.now() < deadline) {}
    return { ok: false as const, error: "broker unreachable: The operation timed out." };
  };

  const { stderr } = await captureStderr(() =>
    servePermission(
      cfg,
      { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
      "tile-1",
      { budgetMs: 10, runClient, writeDecision: () => {} }
    )
  );

  expect(stderr).toContain("permission wait budget expired: broker unreachable: The operation timed out.");
  expect(stderr).not.toContain("permission wait failed");
});

test("an allow verdict returned as the budget expires is emitted", async () => {
  const calls: string[] = [];
  const decisions: string[] = [];
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const runClient = async (
    op: string,
    _rawRequest: string,
    _cfg: ApprovalHookConfig | null,
    _tileRef: string,
    _fetch?: (url: string, init: RequestInit) => Promise<Response>,
    _signal?: AbortSignal
  ) => {
    calls.push(op);
    if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
    const until = performance.now() + 50;
    while (performance.now() < until) {}
    return {
      ok: true as const,
      approval: { id: "approval-1", reply_route: "hook", status: "answered", answer_kind: "allow" },
    };
  };

  await servePermission(
    cfg,
    { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] },
    "tile-1",
    { budgetMs: 30, runClient, writeDecision: (decision) => decisions.push(decision) }
  );

  expect(calls).toEqual(["add", "wait"]);
  expect(decisions).toEqual(["allow"]);
});

describe("servePermission fallbacks", () => {
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "window-1",
    privateKey: "private",
    publicKey: "public",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies ApprovalHookConfig;
  const request = { kind: "permission", title: "Bash", question: "q", options: ["Allow", "Deny"] };

  for (const [name, added] of [
    ["an id", { ok: true as const, producer_secret: "secret-1" }],
    ["a producer secret", { ok: true as const, id: "approval-1" }],
  ] as const) {
    test(`an add answer without ${name} starts no wait`, async () => {
      const calls: string[] = [];
      const decisions: string[] = [];
      const runClient = async (op: string) => {
        calls.push(op);
        return added;
      };

      await captureStderr(() =>
        servePermission(cfg, request, "tile-1", { budgetMs: 1_000, runClient, writeDecision: (d) => decisions.push(d) })
      );

      expect(calls).toEqual(["add"]);
      expect(decisions).toEqual([]);
    });
  }

  test("a broker that only answers pending traces budget expiry and leaves the dialog native", async () => {
    const calls: string[] = [];
    const decisions: string[] = [];
    const runClient = async (op: string) => {
      calls.push(op);
      if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
      if (op === "withdraw") return { ok: true as const, approval: { id: "approval-1", status: "answered_terminal" } };
      await Bun.sleep(5);
      return { ok: true as const, pending: true };
    };

    const { stderr } = await captureStderr(() =>
      servePermission(cfg, request, "tile-1", {
        budgetMs: 50,
        runClient,
        writeDecision: (d) => decisions.push(d),
      })
    );

    expect(calls.filter((op) => op === "wait").length).toBeGreaterThan(1);
    expect(calls.at(-1)).toBe("withdraw");
    expect(calls.filter((op) => op === "withdraw")).toHaveLength(1);
    expect(decisions).toEqual([]);
    expect(stderr.match(/permission wait budget expired/g)).toHaveLength(1);
  });

  test("an exception during the wait is traced and the delivered row is withdrawn", async () => {
    const calls: string[] = [];
    const decisions: string[] = [];
    const runClient = async (op: string) => {
      calls.push(op);
      if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
      if (op === "wait") throw new Error("wait exploded");
      return { ok: true as const, approval: { id: "approval-1", status: "answered_terminal" } };
    };

    const { stderr } = await captureStderr(() =>
      servePermission(cfg, request, "tile-1", { budgetMs: 1_000, runClient, writeDecision: (d) => decisions.push(d) })
    );

    expect(calls).toEqual(["add", "wait", "withdraw"]);
    expect(decisions).toEqual([]);
    expect(stderr).toContain("wait exploded");
  });

  test("an exception during the add is traced and nothing is withdrawn", async () => {
    const calls: string[] = [];
    const runClient = async (op: string) => {
      calls.push(op);
      throw new Error("add exploded");
    };

    const { stderr } = await captureStderr(() =>
      servePermission(cfg, request, "tile-1", { budgetMs: 1_000, runClient, writeDecision: () => {} })
    );

    expect(calls).toEqual(["add"]);
    expect(stderr).toContain("add exploded");
  });

  test("a failing withdraw after an exception is traced too", async () => {
    const runClient = async (op: string) => {
      if (op === "add") return { ok: true as const, id: "approval-1", producer_secret: "secret-1" };
      throw new Error(`${op} exploded`);
    };

    const { stderr } = await captureStderr(() =>
      servePermission(cfg, request, "tile-1", { budgetMs: 1_000, runClient, writeDecision: () => {} })
    );

    expect(stderr).toContain("withdraw exploded");
  });
});

test("PermissionRequest reserves withdrawal grace and margin inside the runner timeout while Notification stays short", () => {
  const hooks = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "desktop", "deck-plugin", "hooks", "hooks.json"), "utf8")
  ) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };

  const RUNNER_TIMEOUT_SEC = 2_147_400;
  const WITHDRAW_AND_MARGIN_SEC = 30;
  const needSec = PERMISSION_BUDGET_MS / 1000 + WITHDRAW_GRACE_SEC + WITHDRAW_AND_MARGIN_SEC;
  expect(PERMISSION_BUDGET_MS).toBe(2_147_350_000);
  expect(hooks.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(RUNNER_TIMEOUT_SEC);
  expect(hooks.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout ?? 0).toBeGreaterThanOrEqual(needSec);
  expect(hooks.hooks.Notification?.[0]?.hooks[0]?.timeout).toBe(20);
});

describe("approval request shaping", () => {
  const cfg: ApprovalHookConfig = {
    brokerUrl: "http://x",
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "tile-1",
    privateKey: "p",
    publicKey: "P",
    origin: { host: "bureau", project_key: "koryphaios" },
  };

  test("a permission request carries the tool, its input and the cwd", () => {
    const body = buildApprovalRequest(
      {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
        cwd: "/home/u/p",
      },
      cfg
    );
    expect(body.kind).toBe("permission");
    expect(body.title).toBe("Bash: rm -rf build");
    expect(String(body.question)).toContain("rm -rf build");
    expect(String(body.question)).toContain("/home/u/p");
    expect(body.options).toEqual(["Allow", "Deny"]);
    expect(body.session_ref).toBe("tile-1");
  });

  test("a sub-agent type visibly prefixes a permission title", () => {
    const body = buildApprovalRequest(
      {
        hook_event_name: "PermissionRequest",
        agent_type: "general-purpose",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      },
      cfg
    );

    expect(body.title).toBe("general-purpose agent -- Bash: rm -rf build");
  });

  test("a long sub-agent type keeps a visible marker and the beginning of a 160-character command", () => {
    const command = "c".repeat(160);
    const body = buildApprovalRequest(
      {
        hook_event_name: "PermissionRequest",
        agent_type: "x".repeat(160),
        tool_name: "Bash",
        tool_input: { command },
      },
      cfg
    );

    expect(String(body.title)).toContain("[truncated from 160 characters]");
    expect(String(body.title)).toContain("[truncated from 166 characters]");
    expect(String(body.title)).toContain(`Bash: ${command.slice(0, 20)}`);
    expect(Array.from(String(body.title)).length).toBeLessThanOrEqual(160);
  });

  test("the tile ref travels as untrusted routing metadata", () => {
    const body = buildApprovalRequest(
      { hook_event_name: "PermissionRequest", tool_name: "Bash" },
      cfg,
      "tile-42"
    );
    expect(body.tile_ref).toBe("tile-42");
    // session_ref stays the AUTHENTICATED window handle; the two are distinct.
    expect(body.session_ref).toBe("tile-1");
  });

  test("a signal event becomes an open question", () => {
    const body = buildApprovalRequest(
      {
        hook_event_name: "Notification",
        notification_type: "agent_needs_input",
        message: "Waiting"
      },
      cfg
    );
    expect(body.kind).toBe("question");
    expect(body.options).toEqual([]);
  });

  test("a tool input past the question bound is cut with a marker naming its real length", () => {
    const body = buildApprovalRequest(
      { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x".repeat(5000) } },
      cfg
    );
    const question = String(body.question);
    const fullLength = Array.from(`The agent wants to use Bash.\nInput: ${JSON.stringify({ command: "x".repeat(5000) })}`).length;
    expect(question.endsWith(`[truncated from ${fullLength} characters]`), question.slice(-60)).toBe(true);
    expect(Array.from(question).length).toBeLessThanOrEqual(4000);
    expect(question).toContain("x".repeat(3000));
  });

  test("a long notification message is cut visibly in the title, whole in the question", () => {
    const message = "m".repeat(400);
    const body = buildApprovalRequest(
      { hook_event_name: "Notification", notification_type: "agent_needs_input", message },
      cfg
    );
    expect(String(body.title).endsWith("[truncated from 400 characters]"), String(body.title)).toBe(true);
    expect(Array.from(String(body.title)).length).toBeLessThanOrEqual(160);
    expect(body.question).toBe(message);
  });

  test("a payload with no message still produces a usable title", () => {
    const body = buildApprovalRequest(
      { hook_event_name: "Notification", notification_type: "agent_needs_input" },
      cfg
    );
    expect(String(body.title).length).toBeGreaterThan(0);
  });
});

describe("hook subprocess", () => {
  async function setup(): Promise<{
    b: TestBroker;
    credFile: string;
    op: { privateKey: string; publicKey: string; id: string };
  }> {
    const b = await startBroker();
    brokers.push(b);
    const dir = mkdtempSync(join(tmpdir(), "cp-hook-"));
    tmpDirs.push(dir);

    const opCred = generateCredential();
    const operatorId = deriveOperatorId(opCred.publicKey);
    const sessionCred = generateCredential();

    const mintBody = {
      session_public_key: sessionCred.publicKey,
      session_ref: "window-1",
      project_key: "koryphaios",
      public_key: opCred.publicKey,
    };
    const auth = buildAuthProof(opCred.privateKey, mintBody, {
      kind: "operator",
      operator_id: operatorId,
    });
    expect((await post(`${b.url}/approval/token-mint`, { ...mintBody, auth })).status).toBe(200);

    const credFile = join(dir, "approval.json");
    writeFileSync(
      credFile,
      JSON.stringify({
        brokerUrl: b.url,
        operatorId,
        tokenId: deriveTokenId(sessionCred.publicKey),
        sessionRef: "window-1",
        privateKey: sessionCred.privateKey,
        publicKey: sessionCred.publicKey,
        origin: { host: "bureau", project_key: "koryphaios" },
      }),
      { mode: 0o600 }
    );
    return { b, credFile, op: { ...opCred, id: operatorId } };
  }

  function runHook(
    credFile: string | null,
    payload: unknown,
    tileRef?: string,
    permissionLease = true
  ): Bun.Subprocess<"pipe", "pipe", "pipe"> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (credFile) env.CLAUDE_PEERS_APPROVAL_FILE = credFile;
    else delete env.CLAUDE_PEERS_APPROVAL_FILE;
    if (tileRef) env.CLAUDE_PEERS_DESK_SESSION = tileRef;
    else delete env.CLAUDE_PEERS_DESK_SESSION;

    const permission =
      typeof payload === "object" && payload !== null && (payload as { hook_event_name?: unknown }).hook_event_name === "PermissionRequest";
    let leaseFile: string | null = null;
    let lease: { version: 1; runId: string; tileId: string; launchId: string; sequence: number; writtenAtMs: number } | null = null;
    if (permission && credFile && permissionLease) {
      lease = {
        version: 1,
        runId: randomUUID(),
        tileId: randomUUID(),
        launchId: randomUUID(),
        sequence: 1,
        writtenAtMs: Date.now(),
      };
      leaseFile = join(dirname(credFile), `${lease.launchId}.json`);
      writeFileSync(leaseFile, JSON.stringify(lease), { mode: 0o600 });
      env.KORY_PERMISSION_LEASE = encodePermissionLeaseDescriptor({ file: leaseFile, ...lease });
    } else {
      delete env.KORY_PERMISSION_LEASE;
    }
    const proc = Bun.spawn(["bun", "desktop/hooks/approval-hook.ts"], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });
    const pulse = lease
      ? setInterval(() => {
          lease.sequence++;
          lease.writtenAtMs = Date.now();
          const temporary = `${leaseFile}.${lease.sequence}.tmp`;
          try {
            writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600 });
            renameSync(temporary, leaseFile as string);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
            process.stderr.write(`permission lease fixture pulse retry: ${code}\n`);
          }
        }, 50)
      : null;
    void proc.exited.finally(() => {
      if (pulse) clearInterval(pulse);
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    return proc;
  }

  async function listApprovals(
    b: TestBroker,
    op: { privateKey: string; publicKey: string; id: string }
  ): Promise<Approval[]> {
    const body = approvalListBody("koryphaios", { public_key: op.publicKey });
    const auth = buildAuthProof(op.privateKey, body, { kind: "operator", operator_id: op.id });
    return (await post<{ approvals: Approval[] }>(`${b.url}/approval/list`, { ...body, auth })).body.approvals;
  }

  async function firstApproval(
    b: TestBroker,
    op: { privateKey: string; publicKey: string; id: string }
  ): Promise<Approval | null> {
    for (let i = 0; i < 60; i++) {
      const found = (await listApprovals(b, op))[0];
      if (found) return found;
      await Bun.sleep(100);
    }
    return null;
  }

  test("transcript payload removes the matching child row without stdout", async () => {
    const { b, credFile, op } = await setup();
    const transcriptPath = join(dirname(credFile), "main.jsonl");
    const childDirectory = join(dirname(transcriptPath), "main", "subagents");
    const requestInput = { command: "echo child" };
    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(
      join(childDirectory, "agent-child.jsonl"),
      [
        { uuid: "prompt", promptId: "prompt-child" },
        { uuid: "tool", parentUuid: "prompt", message: { content: [{ type: "tool_use", id: "tool-child", name: "Bash", input: requestInput }] } },
      ].map((entry) => `${JSON.stringify(entry)}\n`).join("")
    );
    const proc = runHook(credFile, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: requestInput,
      transcript_path: transcriptPath,
      prompt_id: "prompt-child",
      agent_id: "child",
    });
    const stdout = new Response(proc.stdout).text();

    expect(await firstApproval(b, op)).toMatchObject({ reply_route: "hook" });
    writeFileSync(
      join(childDirectory, "agent-child.jsonl"),
      [
        { uuid: "prompt", promptId: "prompt-child" },
        { uuid: "tool", parentUuid: "prompt", message: { content: [{ type: "tool_use", id: "tool-child", name: "Bash", input: requestInput }] } },
        { uuid: "result", parentUuid: "tool", message: { content: [{ type: "tool_result", tool_use_id: "tool-child" }] } },
      ].map((entry) => `${JSON.stringify(entry)}\n`).join("")
    );

    expect(await proc.exited).toBe(0);
    expect((await stdout).trim()).toBe("");
    const approvals = await listApprovals(b, op);
    expect(approvals.filter((approval) => approval.status === "pending")).toEqual([]);
    expect(approvals).toMatchObject([{ status: "answered_terminal" }]);
  });

  test("without a credential the hook is a silent no-op", async () => {
    const proc = runHook(null, { hook_event_name: "PermissionRequest", tool_name: "Bash" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("");
  });

  test("a permission request without a lease does not add an approval", async () => {
    const { b, credFile, op } = await setup();
    const proc = runHook(credFile, { hook_event_name: "PermissionRequest", tool_name: "Bash" }, undefined, false);
    const out = await new Response(proc.stdout).text();

    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("");
    expect(await listApprovals(b, op)).toHaveLength(0);
  });

  for (const toolName of ["AskUserQuestion", "ExitPlanMode"]) {
    test(`${toolName} leaves its native dialog untouched`, async () => {
      const { b, credFile, op } = await setup();
      const proc = runHook(credFile, { hook_event_name: "PermissionRequest", tool_name: toolName });
      try {
        await Bun.sleep(300);
        expect(await listApprovals(b, op)).toHaveLength(0);
        expect(await new Response(proc.stdout).text()).toBe("");
        expect(await proc.exited).toBe(0);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }, 30_000);
  }

  const hostilePermissionPayloads: Array<[string, Record<string, unknown>]> = [
    ["a bidi character in tool input", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: `echo ${String.fromCodePoint(0x202e)}` } }],
    ["a control character in the command", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: `echo ${String.fromCharCode(7)}` } }],
    ["a control character in nested input", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { args: [{ value: String.fromCharCode(0x1f) }] } }],
    ["a format character after a visible cut", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: `${"x".repeat(4_100)}${String.fromCodePoint(0x2060)}` } }],
    ["a format character in cwd", { hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: `C:/work/${String.fromCodePoint(0x2060)}repo` }],
    ["a bidi character in the tool name", { hook_event_name: "PermissionRequest", tool_name: `Ba${String.fromCodePoint(0x202e)}sh` }],
    ["a line separator in a tool input value", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo \u2028x" } }],
    ["a paragraph separator in a tool input value", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo \u2029x" } }],
    ["a bidi character in a tool input key", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { "k\u202ey": "v" } }],
    ["a bell in cwd", { hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: "C:/work\u0007repo" }],
    ["a tab in cwd", { hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: "C:/work\trepo" }],
    ["a line break in cwd", { hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: "C:/work\nAllow every command" }],
    ["a line break in the tool name", { hook_event_name: "PermissionRequest", tool_name: "Bash\nAllow everything" }],
    ["a non-string cwd", { hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: 5 }],
    ["a non-string tool name", { hook_event_name: "PermissionRequest", tool_name: { name: "Bash" } }],
  ];
  for (const [name, payload] of hostilePermissionPayloads) {
    test(`${name} leaves the native permission dialog untouched`, async () => {
      const { b, credFile, op } = await setup();
      const proc = runHook(credFile, payload);
      try {
        await Bun.sleep(300);
        expect(await listApprovals(b, op)).toHaveLength(0);
        expect(await new Response(proc.stdout).text()).toBe("");
        expect(await proc.exited).toBe(0);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }, 30_000);
  }

  test("a multiline tab-indented command is still served", async () => {
    const { b, credFile, op } = await setup();
    const proc = runHook(credFile, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "a\n\tb" },
    });
    try {
      const approval = await firstApproval(b, op);
      expect(approval?.kind).toBe("permission");
      expect(approval?.question).toContain("Input:");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);

  test("a permission request waits for an operator verdict and emits its allow result", async () => {
    const { b, credFile, op } = await setup();
    const proc = runHook(
      credFile,
      {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
        cwd: "/home/u/p",
      },
      "tile-42"
    );

    const approval = await firstApproval(b, op);
    expect(approval).not.toBeNull();
    expect(approval?.kind).toBe("permission");
    expect(approval?.title).toBe("Bash: rm -rf build");
    expect(approval?.status).toBe("pending");
    expect(approval?.origin.session_ref).toBe("window-1");
    expect(approval?.origin.tile_ref).toBe("tile-42");

    const claim = { id: approval?.id, via: "deck", answer_kind: "allow", project_key: "koryphaios" };
    const auth = buildAuthProof(op.privateKey, claim, { kind: "operator", operator_id: op.id });
    const claimed = await post<{ error?: string }>(`${b.url}/approval/claim`, { ...claim, auth });
    expect(claimed.status, claimed.body.error).toBe(200);

    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  }, 30_000);

  test("a deny verdict emits the fixed hook message instead of operator text", async () => {
    const { b, credFile, op } = await setup();
    const proc = runHook(credFile, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    const approval = await firstApproval(b, op);
    const claim = {
      id: approval?.id,
      via: "deck",
      answer_kind: "deny",
      answer_text: "operator-supplied text must not reach Claude Code",
      project_key: "koryphaios",
    };
    const auth = buildAuthProof(op.privateKey, claim, { kind: "operator", operator_id: op.id });
    expect((await post(`${b.url}/approval/claim`, { ...claim, auth })).status).toBe(200);

    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by the operator from Koryphaios" },
      },
    });
    expect(out).not.toContain("operator-supplied");
  }, 30_000);

  test("a terminal handback leaves the native dialog in control without stdout", async () => {
    const { b, credFile, op } = await setup();
    const proc = runHook(credFile, { hook_event_name: "PermissionRequest", tool_name: "Bash" });
    const approval = await firstApproval(b, op);
    const handback = { id: approval?.id, via: "deck", handback: true, project_key: "koryphaios" };
    const auth = buildAuthProof(op.privateKey, handback, { kind: "operator", operator_id: op.id });
    expect((await post(`${b.url}/approval/claim`, { ...handback, auth })).status).toBe(200);

    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toBe("");
  }, 30_000);

  test("a permission delivery failure leaves the native dialog in control without stdout", async () => {
    const { credFile } = await setup();
    const cfg = JSON.parse(readFileSync(credFile, "utf8")) as Record<string, unknown>;
    writeFileSync(credFile, JSON.stringify({ ...cfg, brokerUrl: "http://127.0.0.1:0" }));
    const proc = runHook(credFile, { hook_event_name: "PermissionRequest", tool_name: "Bash" });

    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toBe("");
  });

  test("an open-question notification is registered too", async () => {
    const { b, credFile, op } = await setup();
    const proc = runHook(
      credFile,
      {
        hook_event_name: "Notification",
        notification_type: "agent_needs_input",
        message: "Which migration strategy?",
      },
      "tile-7"
    );
    expect(await proc.exited).toBe(0);

    const approval = await firstApproval(b, op);
    expect(approval?.kind).toBe("question");
    expect(approval?.title).toContain("migration");
    expect(approval?.origin.tile_ref).toBe("tile-7");
  }, 30_000);

  test("a skipped event registers nothing", async () => {
    const { b, credFile, op } = await setup();
    const proc = runHook(
      credFile,
      { hook_event_name: "Notification", notification_type: "permission_prompt" },
      "tile-1"
    );
    expect(await proc.exited).toBe(0);

    const body = approvalListBody("koryphaios", { public_key: op.publicKey });
    const auth = buildAuthProof(op.privateKey, body, { kind: "operator", operator_id: op.id });
    const res = await post<{ approvals: Approval[] }>(`${b.url}/approval/list`, { ...body, auth });
    expect(res.body.approvals).toHaveLength(0);
  }, 30_000);

  test("an idle_prompt notification registers nothing (card 47baf25a)", async () => {
    const { b, credFile, op } = await setup();
    const listPending = async (): Promise<Approval[]> => {
      const body = approvalListBody("koryphaios", { public_key: op.publicKey });
      const auth = buildAuthProof(op.privateKey, body, { kind: "operator", operator_id: op.id });
      const res = await post<{ approvals: Approval[] }>(`${b.url}/approval/list`, {
        ...body,
        auth
      });
      return res.body.approvals;
    };

    const idle = runHook(
      credFile,
      {
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        message: "Claude is waiting for your input"
      },
      "tile-1"
    );
    // No assertion on the exit code: it is `process.exit(0)` unconditionally.
    // Awaiting it is only how we know the process is done writing.
    await idle.exited;
    expect(await listPending()).toHaveLength(0);

    // NEGATIVE CONTROL, same pipe: if the zero above came from a broken hook
    // rather than from the skip, this half cannot pass either.
    const needed = runHook(
      credFile,
      {
        hook_event_name: "Notification",
        notification_type: "agent_needs_input",
        message: "Which migration strategy?"
      },
      "tile-1"
    );
    await needed.exited;
    const after = await listPending();
    expect(after).toHaveLength(1);
    expect(after[0]?.title).toContain("migration");
  }, 30_000);

  test("an unreachable broker fails silently and fast", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-hook-"));
    tmpDirs.push(dir);
    const cred = generateCredential();
    const credFile = join(dir, "approval.json");
    writeFileSync(
      credFile,
      JSON.stringify({
        brokerUrl: "http://127.0.0.1:1", // nothing listens here
        operatorId: "op",
        tokenId: "tok",
        sessionRef: "window-1",
        privateKey: cred.privateKey,
        publicKey: cred.publicKey,
      })
    );
    const started = Date.now();
    const proc = runHook(credFile, { hook_event_name: "PermissionRequest", tool_name: "Bash" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
