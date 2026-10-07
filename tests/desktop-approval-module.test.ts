import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCredential, verifyAuthProof } from "../shared/approval.ts";
import type { SessionApprovalCredential } from "../shared/approval-client.ts";
import {
  APPROVAL_MODULE_ENV,
  register,
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
): { value: ApprovalHost; logs: string[] } {
  const logs: string[] = [];
  return {
    value: {
      env: { get: async (name) => (name === APPROVAL_MODULE_ENV ? gate : undefined) },
      process: { run },
      plugin: { root: PLUGIN_ROOT },
      ui: { log: (text) => void logs.push(text) },
    },
    logs,
  };
}

function nextResolving<T>(value: T): ((e: unknown) => Promise<T>) & { calls: unknown[]; signal: AbortSignal } {
  const calls: unknown[] = [];
  const next = async (e: unknown) => {
    calls.push(e);
    return value;
  };
  return Object.assign(next, { calls, signal: new AbortController().signal });
}

const BASH = { tool: "Bash", input: { command: "rm -rf build" }, tool_use_id: "toolu_1" };
const ASK = { decision: "ask" as const, reason: "core" };

test("tool.check leaves an ask to PermissionRequest without invoking the helper", async () => {
  const calls: string[] = [];
  const probe = host("1", async (argv) => {
    calls.push(String(argv[2]));
    return { exitCode: 0, stdout: '{"ok":true}', stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
  });
  const next = nextResolving(ASK);

  const result = await registered().get("tool.check")!(probe.value, BASH, next);

  expect(result).toBe(ASK);
  expect(next.calls).toEqual([BASH]);
  expect(calls).toEqual([]);
  expect(probe.logs).toEqual(["Kory approvals: permission deferred to PermissionRequest hook"]);
});

test("tool.check returns the engine decision when the approval environment is unavailable", async () => {
  const probe = host("1");
  probe.value.env.get = async () => {
    throw new Error("environment unavailable");
  };
  const next = nextResolving(ASK);

  const result = await registered().get("tool.check")!(probe.value, BASH, next);

  expect(result).toBe(ASK);
  expect(next.calls).toEqual([BASH]);
  expect(probe.logs).toEqual(["Kory approvals: permission defer failed: environment unavailable"]);
});

test("tool.check returns the engine decision unchanged when it is not an ask", async () => {
  const verdict = { decision: "allow", reason: "settings rule" };
  const next = nextResolving(verdict);

  const result = await registered().get("tool.check")!(host("1").value, BASH, next);

  expect(result).toBe(verdict);
  expect(next.calls).toEqual([BASH]);
});

test("tool.call returns next's own result object", async () => {
  const answered = { result: { answers: { "Which?": "A" } }, text: "ok", ref: 3 };
  const next = nextResolving(answered);
  const event = { tool: "AskUserQuestion", tool_use_id: "toolu_2", questions: [] };

  const result = await registered().get("tool.call")!(host("1").value, event, next);

  expect(result).toBe(answered);
  expect(next.calls).toEqual([event]);
});

async function bundle(entry: string): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(HOOKS, entry)], target: "node" });
  expect(built.success, `${entry} bundles`).toBe(true);
  return await built.outputs[0]!.text();
}

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

test("add asks for the hook route and a guarded row; wait timeout is clamped and its HTTP deadline stays under 30 s", () => {
  const cred = generateCredential();
  const cfg = { sessionRef: "tile-1", publicKey: cred.publicKey, origin: {} } as SessionApprovalCredential;

  const add = buildSignedRequest("add", { kind: "question", title: "t", question: "q" }, cfg, "tile-9");
  expect(add).toMatchObject({ path: "/approval/add", payload: { reply_route: "hook", merge: "never", session_ref: "tile-1", tile_ref: "tile-9" } });

  const wait = buildSignedRequest("wait", { id: "a", timeout_sec: 120 }, cfg, "");
  expect(wait).toMatchObject({ payload: { timeout_sec: APPROVAL_WAIT_MAX_SEC } });
  expect((wait as { timeoutMs: number }).timeoutMs, "the HTTP wait ends before 30 s").toBeLessThan(30_000);
  expect(buildSignedRequest("wait", { id: "a", timeout_sec: Number.NaN }, cfg, "")).toMatchObject({ payload: { timeout_sec: APPROVAL_WAIT_MAX_SEC } });
});

test("withdraw posts a session-signed request carrying the producer secret", async () => {
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
