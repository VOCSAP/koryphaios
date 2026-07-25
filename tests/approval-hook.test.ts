import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  deriveTokenId,
  generateCredential,
} from "../shared/approval.ts";
import type { Approval } from "../shared/types.ts";
import {
  buildApprovalRequest,
  buildDecisionOutput,
  classifyPayload,
  loadConfig,
  parseHookPayload,
  summarizeToolInput,
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
  test("PermissionRequest blocks", () => {
    expect(classifyPayload({ hook_event_name: "PermissionRequest" })).toBe("blocking");
  });

  test("Notification signals only for open questions", () => {
    expect(
      classifyPayload({ hook_event_name: "Notification", notification_type: "idle_prompt" })
    ).toBe("signal");
    expect(
      classifyPayload({ hook_event_name: "Notification", notification_type: "agent_needs_input" })
    ).toBe("signal");
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

describe("decision output", () => {
  test("no verdict yields NO decision — the native dialog stands", () => {
    // Fail-closed: the hook may withhold an answer, never invent an allow.
    expect(buildDecisionOutput(null)).toBeNull();
  });

  test("allow maps to behavior allow", () => {
    const out = buildDecisionOutput({ answer_kind: "allow", answer_text: null }) as never;
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    } as never);
  });

  test("deny maps to behavior deny", () => {
    const out = buildDecisionOutput({ answer_kind: "deny", answer_text: null }) as Record<string, never>;
    expect((out.hookSpecificOutput as never as { decision: { behavior: string } }).decision.behavior).toBe(
      "deny"
    );
  });

  test("a free-text answer denies AND carries the operator's words to the agent", () => {
    const out = buildDecisionOutput({
      answer_kind: "text",
      answer_text: "use the staging bucket instead",
    }) as Record<string, string>;
    expect(JSON.stringify(out)).toContain("deny");
    expect(out.additionalContext).toContain("use the staging bucket instead");
    expect(out.systemMessage).toContain("use the staging bucket instead");
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

  test("a signal event becomes an open question", () => {
    const body = buildApprovalRequest(
      { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Waiting" },
      cfg
    );
    expect(body.kind).toBe("question");
    expect(body.options).toEqual([]);
  });

  test("a payload with no message still produces a usable title", () => {
    const body = buildApprovalRequest(
      { hook_event_name: "Notification", notification_type: "agent_needs_input" },
      cfg
    );
    expect(String(body.title).length).toBeGreaterThan(0);
  });
});

// --- The hook as a real subprocess, against a real broker ---
//
// This is the end-to-end proof that needs neither Electron nor Claude Code:
// the hook is just a bun script reading JSON on stdin and writing JSON out.

describe("hook subprocess", () => {
  async function setup(blockSec: number): Promise<{
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

    // The Deck mints the restricted session credential.
    const mintBody = {
      session_public_key: sessionCred.publicKey,
      session_ref: "tile-1",
      public_key: opCred.publicKey,
    };
    const auth = buildAuthProof(opCred.privateKey, mintBody, {
      kind: "operator",
      operator_id: operatorId,
    });
    const minted = await post(`${b.url}/approval/token-mint`, { ...mintBody, auth });
    expect(minted.status).toBe(200);

    const credFile = join(dir, "approval.json");
    writeFileSync(
      credFile,
      JSON.stringify({
        brokerUrl: b.url,
        operatorId,
        tokenId: deriveTokenId(sessionCred.publicKey),
        sessionRef: "tile-1",
        privateKey: sessionCred.privateKey,
        publicKey: sessionCred.publicKey,
        blockSec,
        origin: { host: "bureau", project_key: "koryphaios" },
      }),
      { mode: 0o600 }
    );
    return { b, credFile, op: { ...opCred, id: operatorId } };
  }

  function runHook(credFile: string | null, payload: unknown): ReturnType<typeof Bun.spawn> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (credFile) env.CLAUDE_PEERS_APPROVAL_FILE = credFile;
    else delete env.CLAUDE_PEERS_APPROVAL_FILE;
    const proc = Bun.spawn(["bun", "desktop/hooks/approval-hook.ts"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    return proc;
  }

  async function claimAs(
    b: TestBroker,
    op: { privateKey: string; publicKey: string; id: string },
    id: string,
    answer_kind: string,
    answer_text?: string
  ): Promise<number> {
    const body: Record<string, unknown> = {
      id,
      via: "telegram",
      answer_kind,
      public_key: op.publicKey,
    };
    if (answer_text) body.answer_text = answer_text;
    const auth = buildAuthProof(op.privateKey, body, { kind: "operator", operator_id: op.id });
    const res = await post(`${b.url}/approval/claim`, { ...body, auth });
    return res.status;
  }

  async function firstApproval(
    b: TestBroker,
    op: { privateKey: string; publicKey: string; id: string }
  ): Promise<Approval | null> {
    for (let i = 0; i < 60; i++) {
      const body = { public_key: op.publicKey };
      const auth = buildAuthProof(op.privateKey, body, { kind: "operator", operator_id: op.id });
      const res = await post<{ approvals: Approval[] }>(`${b.url}/approval/list`, { ...body, auth });
      const found = res.body.approvals?.[0];
      if (found) return found;
      await Bun.sleep(100);
    }
    return null;
  }

  test("without a credential the hook is a silent no-op", async () => {
    const proc = runHook(null, { hook_event_name: "PermissionRequest", tool_name: "Bash" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("");
  });

  test("a permission request creates an approval and blocks until it is settled", async () => {
    const { b, credFile, op } = await setup(60);
    const proc = runHook(credFile, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
      cwd: "/home/u/p",
    });

    const approval = await firstApproval(b, op);
    expect(approval).not.toBeNull();
    expect(approval?.title).toBe("Bash: rm -rf build");
    expect(approval?.origin.session_ref).toBe("tile-1");

    expect(await claimAs(b, op, approval!.id, "allow")).toBe(200);

    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  }, 30_000);

  test("a free-text answer denies and forwards the operator's words", async () => {
    const { b, credFile, op } = await setup(60);
    const proc = runHook(credFile, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "deploy prod" },
    });

    const approval = await firstApproval(b, op);
    expect(await claimAs(b, op, approval!.id, "text", "deploy to staging first")).toBe(200);

    const parsed = JSON.parse(await new Response(proc.stdout).text());
    await proc.exited;
    expect(JSON.stringify(parsed)).toContain("deny");
    expect(parsed.additionalContext).toContain("deploy to staging first");
  }, 30_000);

  test("when the block budget expires the hook yields NO decision", async () => {
    // The session stays blocked on its native dialog and the operator answers
    // in the Deck — exactly the "the notification expires, the session does
    // not" contract.
    const { b, credFile, op } = await setup(1);
    const proc = runHook(credFile, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "sleep" },
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("");

    // ...and the approval is still pending, still answerable.
    const approval = await firstApproval(b, op);
    expect(approval?.status).toBe("pending");
  }, 30_000);

  test("a signal event registers an approval without blocking", async () => {
    const { b, credFile, op } = await setup(60);
    const started = Date.now();
    const proc = runHook(credFile, {
      hook_event_name: "Notification",
      notification_type: "agent_needs_input",
      message: "Which migration strategy?",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("");
    // It must NOT have waited for the 60 s budget.
    expect(Date.now() - started).toBeLessThan(20_000);

    const approval = await firstApproval(b, op);
    expect(approval?.kind).toBe("question");
    expect(approval?.title).toContain("migration");
  }, 30_000);

  test("an unreachable broker fails closed (no decision, no hang)", async () => {
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
        sessionRef: "tile-1",
        privateKey: cred.privateKey,
        publicKey: cred.publicKey,
        blockSec: 5,
      })
    );
    const proc = runHook(credFile, { hook_event_name: "PermissionRequest", tool_name: "Bash" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("");
  }, 30_000);
});
