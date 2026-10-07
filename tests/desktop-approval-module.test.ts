import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_QUESTION_MAX, generateCredential, verifyAuthProof } from "../shared/approval.ts";
import type { SessionApprovalCredential } from "../shared/approval-client.ts";
import {
  ALLOW_REASON,
  APPROVAL_MODULE_ENV,
  approvalHelperPath,
  callApprovalHelper,
  DENY_REASON,
  permissionQuestion,
  register,
  VERDICT_CEILING_MS,
  VERDICT_WAIT_SEC,
  type ApprovalHost,
} from "../desktop/hooks/kory-approvals.ts";
import { APPROVAL_WAIT_MAX_SEC, buildSignedRequest, runApprovalClient } from "../desktop/hooks/approval-client.ts";
import type { ProcessRunInit, ProcessRunResult } from "../desktop/hooks/claude-code-types.ts";

const HOOKS = join(import.meta.dir, "..", "desktop", "hooks");
const PLUGIN_ROOT = "C:/plugins/deck";

type Handler = (...args: unknown[]) => Promise<unknown>;

function registered(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  register(((event: string, ...args: unknown[]) => {
    const handler = args.at(-1);
    if (typeof handler === "function") handlers.set(event, handler as Handler);
  }) as never);
  return handlers;
}

function host(
  gate: string | undefined,
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult> = async () => {
    throw new Error("process.run must not be called");
  },
  now: () => Promise<number> = async () => 0,
  cwd: () => Promise<string> = async () => "C:/work/repo",
): { value: ApprovalHost; logs: string[] } {
  const logs: string[] = [];
  return {
    value: {
      env: { get: async (name) => (name === APPROVAL_MODULE_ENV ? gate : undefined) },
      process: { run },
      plugin: { root: PLUGIN_ROOT },
      ui: { log: (text) => void logs.push(text) },
      clock: { now },
      session: { cwd },
    },
    logs,
  };
}

function nextResolving<T>(
  value: T,
  controller = new AbortController(),
): ((e: unknown) => Promise<T>) & { calls: unknown[]; signal: AbortSignal } {
  const calls: unknown[] = [];
  const next = async (e: unknown) => {
    calls.push(e);
    return value;
  };
  return Object.assign(next, { calls, signal: controller.signal });
}

function stdout(body: unknown): ProcessRunResult {
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
}

const FAILED: ProcessRunResult = { exitCode: 1, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
const PENDING = { ok: true, pending: true };
const ADDED = { ok: true, id: "ap-1", reply_route: "hook", producer_secret: "ps-1" };

function answered(fields: Record<string, unknown>): unknown {
  return { ok: true, approval: { id: "ap-1", reply_route: "hook", status: "answered", ...fields } };
}

/**
 * A fake approval helper: add answers `add`, each wait takes the next of `waits` (a function runs first), then fails.
 * `withdrawFails` plays the broker's 409 when the operator answered first.
 */
function helper(add: unknown, waits: unknown[] = [], withdrawFails = false) {
  const calls: Array<{ op: string; request: Record<string, unknown> }> = [];
  const run = async (argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> => {
    const op = argv[2]!;
    calls.push({ op, request: JSON.parse(init?.stdin ?? "{}") });
    if (op === "add") return add === null ? FAILED : stdout(add);
    if (op === "withdraw") {
      return withdrawFails
        ? stdout({ ok: false, error: "HTTP 409: already answered" })
        : stdout({ ok: true, approval: { id: "ap-1", status: "answered_terminal" } });
    }
    if (waits.length === 0) return FAILED;
    const step = waits.shift();
    const body = typeof step === "function" ? step() : step;
    return body === null ? FAILED : stdout(body);
  };
  return { run, calls, ops: () => calls.map((c) => c.op) };
}

const BASH = { tool: "Bash", input: { command: "rm -rf build" }, tool_use_id: "toolu_1" };
const ASK = { decision: "ask" as const, reason: "core" };

for (const gate of ["1", ""]) {
  for (const decision of ["allow", "deny"] as const) {
    test(`a ${decision} from next is returned untouched, no helper call (gate '${gate}')`, async () => {
      const verdict = { decision, reason: "core" };
      const next = nextResolving(verdict);

      const result = await registered().get("tool.check")!(host(gate).value, BASH, next);

      expect(result).toBe(verdict);
      expect(next.calls).toEqual([BASH]);
    });
  }

  test(`tool.call returns next's own result object (gate '${gate}')`, async () => {
    const answered = { result: { answers: { "Which?": "A" } }, text: "ok", ref: 3 };
    const e = { tool: "AskUserQuestion", tool_use_id: "toolu_2", questions: [] };
    const next = nextResolving(answered);

    const result = await registered().get("tool.call")!(host(gate).value, e, next);

    expect(result).toBe(answered);
    expect(next.calls).toEqual([e]);
  });
}

test("an ask is not served when the module is off, the call is a query, or the tool keeps its own dialog", async () => {
  const check = registered().get("tool.check")!;
  const cases = [
    { gate: "", e: BASH },
    { gate: "1", e: { tool: "Bash", input: {} } },
    { gate: "1", e: { tool: "AskUserQuestion", input: {}, tool_use_id: "toolu_q" } },
    { gate: "1", e: { tool: "ExitPlanMode", input: {}, tool_use_id: "toolu_p" } },
  ];
  for (const { gate, e } of cases) {
    const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);
    const next = nextResolving(ASK);
    expect(await check(host(gate, fake.run).value, e, next), JSON.stringify(e)).toBe(ASK);
    expect(fake.ops(), `${e.tool} (gate '${gate}') reaches no helper`).toEqual([]);
    expect(next.calls).toHaveLength(1);
  }
});

test("pending then allow: the operator's allow runs the tool, with a fixed reason", async () => {
  const fake = helper(ADDED, [PENDING, answered({ answer_kind: "allow", answer_text: "free text" })]);
  const next = nextResolving(ASK);

  const result = await registered().get("tool.check")!(host("1", fake.run).value, BASH, next);

  expect(result).toEqual({ decision: "allow", reason: ALLOW_REASON });
  expect(fake.ops()).toEqual(["add", "wait", "wait"]);
  expect(next.calls, "next is called once, never after the wait").toHaveLength(1);
  const add = fake.calls[0]!.request;
  expect(add).toMatchObject({ kind: "permission", title: "Bash: rm -rf build", options: ["Allow", "Deny"] });
  expect(String(add.question).split("\n")[0], "the command comes first, verbatim").toBe("rm -rf build");
  expect(String(add.question).split("\n")[1], "the session directory comes right after").toBe("Dir: C:/work/repo");
  expect(fake.calls[1]!.request).toEqual({ id: "ap-1", producer_secret: "ps-1", timeout_sec: VERDICT_WAIT_SEC });
});

test("pending then deny: the reason is fixed, never the operator's text", async () => {
  const fake = helper(ADDED, [PENDING, answered({ answer_kind: "deny", answer_text: "do not touch build" })]);

  const result = await registered().get("tool.check")!(host("1", fake.run).value, BASH, nextResolving(ASK));

  expect(result).toEqual({ decision: "deny", reason: DENY_REASON });
  expect(JSON.stringify(result)).not.toContain("do not touch");
});

test("a long command is cut visibly in the question, the command still first", () => {
  const question = permissionQuestion({ command: "x".repeat(APPROVAL_QUESTION_MAX + 10) }, "C:/work/repo");
  expect(Array.from(question).length).toBeLessThanOrEqual(APPROVAL_QUESTION_MAX);
  expect(question).toContain("[truncated from");
  expect(question.startsWith("xxx")).toBe(true);
});

/** Every way the module ends without an operator verdict: it must return next's own ask, never allow. */
const FALLBACKS: Array<{ name: string; add: unknown; waits?: unknown[]; ops: string[]; abortOnWait?: boolean; now?: () => Promise<number> }> = [
  { name: "add fails", add: null, ops: ["add"] },
  { name: "add answers another route", add: { ...ADDED, reply_route: "channel" }, ops: ["add"] },
  { name: "the operator hands back", add: ADDED, waits: [PENDING, answered({ status: "answered_terminal", answer_kind: null })], ops: ["add", "wait", "wait", "withdraw"] },
  { name: "the wait answers another id", add: ADDED, waits: [{ ok: true, approval: { id: "ap-2", reply_route: "hook", status: "answered", answer_kind: "allow" } }], ops: ["add", "wait", "withdraw"] },
  { name: "the helper fails while waiting", add: ADDED, waits: [PENDING, null], ops: ["add", "wait", "wait", "withdraw"] },
  { name: "Escape while waiting, even if the wait then says allow", add: ADDED, waits: [answered({ answer_kind: "allow" })], abortOnWait: true, ops: ["add", "wait", "withdraw"] },
];

for (const c of FALLBACKS) {
  test(`fallback: ${c.name} -> withdraw when added, return next's ask`, async () => {
    const controller = new AbortController();
    const waits = (c.waits ?? []).map((w) => (c.abortOnWait ? () => (controller.abort("user-cancel"), w) : w));
    const fake = helper(c.add, waits);
    const next = nextResolving(ASK, controller);

    const result = await registered().get("tool.check")!(host("1", fake.run, c.now).value, BASH, next);

    expect(result, "only an operator's allow may allow; every fallback returns next's own verdict").toBe(ASK);
    expect(fake.ops()).toEqual(c.ops);
    expect(next.calls, "next is never called again").toHaveLength(1);
  });
}

test("fallback: the 30 min ceiling withdraws a row the operator never answered", async () => {
  let t = 0;
  const fake = helper(ADDED, Array.from({ length: 100 }, () => PENDING));
  const now = async () => (t += 10 * 60_000);

  const result = await registered().get("tool.check")!(host("1", fake.run, now).value, BASH, nextResolving(ASK));

  expect(result).toBe(ASK);
  expect(fake.ops().at(-1)).toBe("withdraw");
  expect(fake.ops().filter((op) => op === "wait").length).toBeLessThan(VERDICT_CEILING_MS / 60_000);
});

test("fallback: an exception after add withdraws and returns next's ask", async () => {
  const fake = helper(ADDED, [PENDING]);
  const probe = host("1", fake.run, async () => {
    throw new Error("clock down");
  });

  const result = await registered().get("tool.check")!(probe.value, BASH, nextResolving(ASK));

  expect(result).toBe(ASK);
  expect(fake.ops()).toEqual(["add", "withdraw"]);
  expect(probe.logs).toContain("Kory permission wait failed: clock down");
});

test("fallback: an exception before add returns next's ask", async () => {
  const probe = host("1");
  probe.value.env.get = async () => {
    throw new Error("env down");
  };
  expect(await registered().get("tool.check")!(probe.value, BASH, nextResolving(ASK))).toBe(ASK);
  expect(probe.logs).toEqual(["Kory approvals failed: env down"]);
});

test("a deny or an allow from the engine is never turned into an operator request", async () => {
  for (const decision of ["deny", "allow"] as const) {
    const verdict = { decision, reason: "settings rule" };
    const fake = helper(ADDED, [answered({ answer_kind: decision === "deny" ? "allow" : "deny" })]);

    const result = await registered().get("tool.check")!(host("1", fake.run).value, BASH, nextResolving(verdict));

    expect(result, `an engine ${decision} must reach the tile untouched; the operator cannot overturn it`).toBe(verdict);
    expect(fake.ops()).toEqual([]);
  }
});

test("a call carrying bidi or other format characters is left to the native menu, unchanged", async () => {
  const cp = (n: number) => String.fromCodePoint(n);
  const [RLO, LRI, PDI, PDF] = [cp(0x202e), cp(0x2066), cp(0x2069), cp(0x202c)];
  const trojan = `ls ${RLO}${LRI} ; rm -rf ~/x ${PDI}${LRI} # list files ${PDI}${PDF}`;
  for (const command of [trojan, `ls${cp(0x200b)}`, `ls${cp(0x2028)}rm -rf ~/x`]) {
    const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);
    const probe = host("1", fake.run);
    const e = { tool: "Bash", input: { command }, tool_use_id: "toolu_b" };

    const result = await registered().get("tool.check")!(probe.value, e, nextResolving(ASK));

    expect(result, "a reordered command never reaches the operator").toBe(ASK);
    expect(fake.ops()).toEqual([]);
    expect(probe.logs).toEqual(["Kory approvals: format characters in the call, left to the native menu"]);
  }
});

test("without a session directory the call is still served, with no Dir line", async () => {
  const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);
  const probe = host("1", fake.run, undefined, async () => {
    throw new Error("no cwd");
  });

  const result = await registered().get("tool.check")!(probe.value, BASH, nextResolving(ASK));

  expect(result).toEqual({ decision: "allow", reason: ALLOW_REASON });
  expect(String(fake.calls[0]!.request.question)).not.toContain("Dir:");
  expect(probe.logs).toContain("Kory approvals: no session cwd: no cwd");
});

test("fallback: a signal already aborted before the first wait withdraws at once", async () => {
  const controller = new AbortController();
  controller.abort("user-cancel");
  const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);

  const result = await registered().get("tool.check")!(host("1", fake.run).value, BASH, nextResolving(ASK, controller));

  expect(result).toBe(ASK);
  expect(fake.ops()).toEqual(["add", "withdraw"]);
});

test("a withdraw refused because the operator just answered applies that answer, read once", async () => {
  for (const [late, expected] of [
    [answered({ answer_kind: "allow" }), { decision: "allow", reason: ALLOW_REASON }],
    [answered({ answer_kind: "deny" }), { decision: "deny", reason: DENY_REASON }],
    [PENDING, ASK],
  ] as const) {
    const fake = helper(ADDED, [PENDING, null, late], true);

    const result = await registered().get("tool.check")!(host("1", fake.run).value, BASH, nextResolving(ASK));

    expect(result).toEqual(expected);
    expect(fake.ops()).toEqual(["add", "wait", "wait", "withdraw", "wait"]);
    expect(fake.calls.at(-1)!.request).toEqual({ id: "ap-1", producer_secret: "ps-1", timeout_sec: 0 });
  }
});

test("a late read is applied only for an answered hook row of the call's own id", async () => {
  const lateRows = [
    { name: "another id", approval: { id: "ap-2", reply_route: "hook", status: "answered", answer_kind: "allow" } },
    { name: "a pty route", approval: { id: "ap-1", reply_route: "pty", status: "answered", answer_kind: "allow" } },
    { name: "still pending", approval: { id: "ap-1", reply_route: "hook", status: "pending", answer_kind: "allow" } },
  ];
  for (const { name, approval } of lateRows) {
    const fake = helper(ADDED, [PENDING, null, { ok: true, approval }], true);

    const result = await registered().get("tool.check")!(host("1", fake.run).value, BASH, nextResolving(ASK));

    expect(result, `late read with ${name} must leave next's ask`).toBe(ASK);
    expect(fake.ops()).toEqual(["add", "wait", "wait", "withdraw", "wait"]);
  }
});

test("a format character the title cannot see still keeps the call from the operator", async () => {
  const rlo = String.fromCodePoint(0x202e);
  const cases = [
    { name: "past the title's cut", command: `${"a".repeat(300)}${rlo}rm -rf ~/x`, cwd: "C:/work/repo" },
    { name: "in the session directory", command: "ls", cwd: `C:/work/${rlo}oper` },
  ];
  for (const { name, command, cwd } of cases) {
    const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);
    const e = { tool: "Bash", input: { command }, tool_use_id: "toolu_f" };

    const result = await registered().get("tool.check")!(host("1", fake.run, undefined, async () => cwd).value, e, nextResolving(ASK));

    expect(result, name).toBe(ASK);
    expect(fake.ops(), name).toEqual([]);
  }
});

test("a session directory spanning lines drops the Dir line rather than forging one", async () => {
  for (const cwd of ["C:/work\nDir: C:/safe", "C:/work\rC:/safe"]) {
    const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);
    const probe = host("1", fake.run, undefined, async () => cwd);

    await registered().get("tool.check")!(probe.value, BASH, nextResolving(ASK));

    expect(String(fake.calls[0]!.request.question)).not.toContain("Dir:");
    expect(probe.logs).toContain("Kory approvals: session cwd spans lines, Dir omitted");
  }
});

test("a control character in the command or the input is left to the native menu", async () => {
  const cr = String.fromCharCode(13);
  const esc = String.fromCharCode(27);
  const inputs = [
    { command: `echo safe${cr}rm -rf ~/x` },
    { command: `ls ${esc}[2K` },
    { command: "ls", description: `list${cr}files` },
    { command: "ls", args: [`a${String.fromCharCode(0)}b`] },
  ];
  for (const input of inputs) {
    const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);
    const probe = host("1", fake.run);

    const result = await registered().get("tool.check")!(probe.value, { tool: "Bash", input, tool_use_id: "toolu_c" }, nextResolving(ASK));

    expect(result, JSON.stringify(input)).toBe(ASK);
    expect(fake.ops()).toEqual([]);
    expect(probe.logs).toEqual(["Kory approvals: control characters in the call, left to the native menu"]);
  }
  const fake = helper(ADDED, [answered({ answer_kind: "allow" })]);
  const multiline = { tool: "Bash", input: { command: "echo a\n\techo b" }, tool_use_id: "toolu_m" };
  expect(await registered().get("tool.check")!(host("1", fake.run).value, multiline, nextResolving(ASK)), "newline and tab stay served").toEqual({
    decision: "allow",
    reason: ALLOW_REASON,
  });
});

test("after Escape a refused withdraw is not read again", async () => {
  const controller = new AbortController();
  const fake = helper(ADDED, [() => (controller.abort("user-cancel"), PENDING), answered({ answer_kind: "allow" })], true);

  const result = await registered().get("tool.check")!(host("1", fake.run).value, BASH, nextResolving(ASK, controller));

  expect(result).toBe(ASK);
  expect(fake.ops()).toEqual(["add", "wait", "withdraw"]);
});

test("the helper is spawned from the plugin root with the request on stdin", async () => {
  const runs: Array<{ argv: readonly string[]; init?: ProcessRunInit }> = [];
  const probe = host("1", async (argv, init) => {
    runs.push({ argv, init });
    return { exitCode: 0, stdout: '{"ok":true,"id":"ap-1"}\n', stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
  });

  const out = await callApprovalHelper(probe.value, "add", { kind: "permission" });

  expect(out).toEqual({ ok: true, id: "ap-1" });
  expect(runs[0]!.argv).toEqual(["bun", `${PLUGIN_ROOT}/hooks/approval-client.mjs`, "add"]);
  expect(JSON.parse(runs[0]!.init!.stdin!)).toEqual({ kind: "permission" });
  expect(approvalHelperPath("C:/plugins/deck/")).toBe(`${PLUGIN_ROOT}/hooks/approval-client.mjs`);
});

test("every helper failure reads as no answer, never as a refusal", async () => {
  const outcomes: Array<() => Promise<ProcessRunResult>> = [
    async () => ({ exitCode: 1, stdout: '{"ok":true}', stderr: "", isStdoutTruncated: false, isStderrTruncated: false }),
    async () => ({ exitCode: 0, stdout: '{"ok":false,"error":"HTTP 404"}', stderr: "", isStdoutTruncated: false, isStderrTruncated: false }),
    async () => ({ exitCode: 0, stdout: "not json", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }),
    async () => {
      throw new Error("bun not found");
    },
  ];
  for (const outcome of outcomes) {
    const probe = host("1", outcome);
    expect(await callApprovalHelper(probe.value, "wait", { id: "x" })).toBeNull();
    expect(probe.logs).toHaveLength(1);
  }
});

/** What the Claude Code engine cannot load: any non-relative import (static, side-effect, re-export or dynamic), `require`, `process`. */
function engineForbidden(code: string): string[] {
  const found: string[] = [];
  const specifiers = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of specifiers) {
    for (const m of code.matchAll(pattern)) {
      const spec = m[1] ?? "";
      if (!spec.startsWith("./") && !spec.startsWith("../")) found.push(`import ${spec}`);
    }
  }
  if (/\bimport\s*\(/.test(code)) found.push("import(");
  if (/\brequire\s*\(/.test(code)) found.push("require(");
  if (/(?<!\$\.)\bprocess\b(?!\s*:)/.test(code)) found.push("process.");
  return found;
}

async function bundle(entry: string): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(HOOKS, entry)], target: "node" });
  expect(built.success, `${entry} bundles`).toBe(true);
  return await built.outputs[0]!.text();
}

test("the engine-loading guard flags every way to reach a host module", () => {
  const forms = [
    'import { sign } from "node:crypto";',
    'import "node:crypto";',
    'const c = await import("node:crypto");',
    'export { sign } from "crypto";',
    'const c = require("crypto");',
    "const home = process.env.HOME;",
    "const home = globalThis.process.env.HOME;",
    "self.process.exit(0);",
    "const { env } = process;",
  ];
  for (const form of forms) expect(engineForbidden(`const a = 1;\n${form}\n`), form).not.toEqual([]);
  expect(engineForbidden('const a = "from the import";\nexport { a };\n')).toEqual([]);
  expect(engineForbidden('await $.process.run(["bun"]);\n'), "the host's own $.process is not node's process").toEqual([]);
});

test("the engine module bundle needs nothing the engine lacks; the bun helper does (control)", async () => {
  const moduleCode = await bundle("kory-module.ts");
  const helperCode = await bundle("approval-client.ts");

  expect(engineForbidden(helperCode), "positive control: the signing helper imports node:crypto").toContain("import node:crypto");
  expect(engineForbidden(moduleCode), "the Claude Code engine has no node:*, require or process").toEqual([]);
  expect(moduleCode).toContain("tool.check");
  expect(moduleCode).toContain("session.measure");
});

test("a malformed private key yields one ok:false line and exit 0", async () => {
  const cfg: SessionApprovalCredential = {
    brokerUrl: "http://127.0.0.1:9",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "tile-1",
    privateKey: "not-a-key",
    publicKey: "not-a-key",
    osUserHash: "",
    blockSec: 900,
    origin: {},
  };
  const inProcess = await runApprovalClient("wait", '{"id":"a"}', cfg, "");
  expect(inProcess.ok).toBe(false);

  const dir = mkdtempSync(join(tmpdir(), "kory-approval-client-"));
  try {
    const credFile = join(dir, "cred.json");
    writeFileSync(credFile, JSON.stringify(cfg));
    const run = Bun.spawnSync(["bun", join(HOOKS, "approval-client.ts"), "add"], {
      stdin: new TextEncoder().encode('{"kind":"permission"}'),
      env: { ...process.env, CLAUDE_PEERS_APPROVAL_FILE: credFile },
    });
    const lines = run.stdout.toString().split("\n").filter(Boolean);
    expect(run.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wait and withdraw relay only the allow-listed approval fields", async () => {
  const cred = generateCredential();
  const cfg = {
    brokerUrl: "http://broker.test",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "tile-1",
    privateKey: cred.privateKey,
    publicKey: cred.publicKey,
    osUserHash: "",
    blockSec: 900,
    origin: {},
  } satisfies SessionApprovalCredential;
  const leaky = (async () =>
    Response.json({
      token: "top-secret",
      approval: { id: "ap-1", status: "answered", answer_kind: "allow", reply_token: "rt-secret", origin: { host: "h" } },
    })) as never;

  for (const op of ["wait", "withdraw"]) {
    const out = await runApprovalClient(op, '{"id":"ap-1"}', cfg, "", leaky);
    expect(out, op).toEqual({ ok: true, approval: { id: "ap-1", status: "answered", answer_kind: "allow" } });
    expect(JSON.stringify(out)).not.toContain("secret");
  }
});

test("helper refusals come back as ok:false, never as a verdict", async () => {
  const cred = generateCredential();
  const cfg: SessionApprovalCredential = {
    brokerUrl: "http://127.0.0.1:9",
    brokerToken: null,
    operatorId: "op",
    tokenId: "tok",
    sessionRef: "tile-1",
    privateKey: cred.privateKey,
    publicKey: cred.publicKey,
    osUserHash: "",
    blockSec: 900,
    origin: {},
  };
  const unreachable: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as never;

  expect(await runApprovalClient("add", "{}", null, "")).toEqual({ ok: false, error: "no approval credential" });
  expect(await runApprovalClient("add", "not json", cfg, "")).toEqual({ ok: false, error: "request is not JSON" });
  expect(await runApprovalClient("claim", "{}", cfg, "")).toEqual({ ok: false, error: "unknown op: claim" });
  expect(await runApprovalClient("wait", "{}", cfg, "")).toEqual({ ok: false, error: "wait needs an id" });
  expect((await runApprovalClient("wait", '{"id":"a"}', cfg, "", unreachable)).ok).toBe(false);
});

test("add asks for the hook route and a guarded row; wait stays under the engine's per-call ceiling", () => {
  const cred = generateCredential();
  const cfg = { sessionRef: "tile-1", publicKey: cred.publicKey, origin: {} } as SessionApprovalCredential;

  const add = buildSignedRequest("add", { kind: "question", title: "t", question: "q" }, cfg, "tile-9");
  expect(add).toMatchObject({ path: "/approval/add", payload: { reply_route: "hook", merge: "never", session_ref: "tile-1", tile_ref: "tile-9" } });

  const wait = buildSignedRequest("wait", { id: "a", timeout_sec: 120 }, cfg, "");
  expect(wait).toMatchObject({ payload: { timeout_sec: APPROVAL_WAIT_MAX_SEC } });
  expect((wait as { timeoutMs: number }).timeoutMs, "the HTTP wait ends before the module's 30 s process timeout").toBeLessThan(30_000);
  expect(buildSignedRequest("wait", { id: "a", timeout_sec: Number.NaN }, cfg, "")).toMatchObject({ payload: { timeout_sec: APPROVAL_WAIT_MAX_SEC } });
});

test("withdraw posts a session-signed request for the module's own id", async () => {
  const cred = generateCredential();
  const cfg: SessionApprovalCredential = {
    brokerUrl: "http://broker.test",
    brokerToken: "bearer-1",
    operatorId: "op-1",
    tokenId: "tok-1",
    sessionRef: "tile-1",
    privateKey: cred.privateKey,
    publicKey: cred.publicKey,
    osUserHash: "",
    blockSec: 900,
    origin: {},
  };
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return Response.json({ approval: { id: "ap-7", status: "answered_terminal" } });
  }) as never;

  const out = await runApprovalClient("withdraw", '{"id":"ap-7","producer_secret":"ps-1"}', cfg, "tile-1", fake);

  expect(out).toEqual({ ok: true, approval: { id: "ap-7", status: "answered_terminal" } });
  expect(sent[0]!.url).toBe("http://broker.test/approval/withdraw");
  expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer bearer-1");
  const { auth, ...payload } = JSON.parse(sent[0]!.init.body as string);
  expect(payload, "the secret travels inside the signed payload").toEqual({
    id: "ap-7",
    public_key: cred.publicKey,
    producer_secret: "ps-1",
  });
  expect(auth).toMatchObject({ kind: "session", operator_id: "op-1", token_id: "tok-1" });
  expect(verifyAuthProof(cred.publicKey, payload, auth)).toEqual({ ok: true });
});
