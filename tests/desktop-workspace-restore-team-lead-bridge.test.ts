// Card 6363bd69: a workspace-restored team-lead AGENT tile (agent==='team-lead',
// never the separate `lead` window-routing flag) must get the same
// deck-control bridge a fresh spawn or a template entry already gets. Restore
// bypasses SessionService.create()/resolveMcpConfig entirely -- args is the
// only surviving signal, so this file proves both the extraction bound and
// that the real restoreFrom()/ipc.ts wiring actually delegates to it.

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentFromRestoredArgs,
  isTeamLeadAgent,
  resolveMcpConfig,
  type MintTeamLeadBridge
} from "../desktop/src/main/team-lead-bridge";
import {
  WorkspaceService,
  type WorkspaceDeps
} from "../desktop/src/main/workspace-service";
import { newWorkspaceId, saveWorkspace, type Workspace } from "../desktop/src/main/workspace-store";
import { extractBracedBody } from "./_braced-body";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");
const IPC_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts");

// ----- agentFromRestoredArgs: bounded extraction, fails closed -----

test("recovers the agent from the exact --agent \"value\" shape create() writes", () => {
  expect(agentFromRestoredArgs('--agent "team-lead"')).toBe("team-lead");
  expect(agentFromRestoredArgs('--agent "team-lead" --model "opus"')).toBe("team-lead");
  expect(agentFromRestoredArgs('--model "opus" --agent "reviewer" --effort "high"')).toBe("reviewer");
});

test("returns undefined on zero matches", () => {
  expect(agentFromRestoredArgs("")).toBeUndefined();
  expect(agentFromRestoredArgs("--model \"opus\"")).toBeUndefined();
});

test("fails closed on more than one --agent occurrence rather than taking the first (hand-edited workspace file)", () => {
  expect(agentFromRestoredArgs('--agent "team-lead" --agent "developer"')).toBeUndefined();
});

test("fails closed on missing quotes, empty value, or a glued suffix", () => {
  expect(agentFromRestoredArgs("--agent team-lead")).toBeUndefined();
  expect(agentFromRestoredArgs('--agent ""')).toBeUndefined();
  expect(agentFromRestoredArgs('--agent "team-lead"x')).toBeUndefined();
  expect(agentFromRestoredArgs('x--agent "team-lead"')).toBeUndefined();
});

test("card 6363bd69: the recovered value round-trips through the SAME isTeamLeadAgent predicate every other route uses", () => {
  expect(isTeamLeadAgent(agentFromRestoredArgs('--agent "team-lead"'))).toBe(true);
  expect(isTeamLeadAgent(agentFromRestoredArgs('--agent "reviewer"'))).toBe(false);
  expect(isTeamLeadAgent(agentFromRestoredArgs(""))).toBe(false);
});

// ----- WorkspaceService.hasTeamLeadAgentSession: real class, real fs -----
// (workspace-service.ts's own header: no electron/node-pty import, bun-testable directly.)

const tmpDirs: string[] = [];
function freshProject(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-wsp-restore-bridge-"));
  tmpDirs.push(d);
  return d;
}

function sampleWorkspace(sessionsArgs: string[][]): Workspace {
  return {
    id: newWorkspaceId(),
    name: "team",
    pinned: false,
    cwd: "/abs/project",
    groupId: "a".repeat(64),
    scopeName: "dev-pc-foo",
    scopeKind: "ephemeral",
    displayMode: { kind: "grid", x: 2, y: 2 },
    createdAt: 1000,
    updatedAt: 1000,
    sessions: sessionsArgs.map((args, i) => ({
      claudeSessionId: `sid-${i}`,
      name: `s${i}`,
      cwd: "/abs/project",
      args,
      color: "#4488ff",
      position: i
    }))
  };
}

function minimalDeps(proj: string): WorkspaceDeps {
  return {
    projectDir: proj,
    service: {} as WorkspaceDeps["service"],
    getConfig: () => ({}) as never,
    setConfig: () => {},
    getScope: () => ({}) as never,
    adoptScope: () => {},
    confirmShellFields: () => "approved",
    confirmUntrustedCwd: () => "approved"
  };
}

test("hasTeamLeadAgentSession: true when a persisted session carries --agent \"team-lead\"", () => {
  const proj = freshProject();
  const svc = new WorkspaceService(minimalDeps(proj));
  const ws = sampleWorkspace([["--agent", '"reviewer"'], ["--agent", '"team-lead"']]);
  saveWorkspace(proj, ws);
  expect(svc.hasTeamLeadAgentSession(ws.id)).toBe(true);
});

test("hasTeamLeadAgentSession: false when no session is the team-lead agent", () => {
  const proj = freshProject();
  const svc = new WorkspaceService(minimalDeps(proj));
  const ws = sampleWorkspace([["--agent", '"reviewer"'], ["--model", '"opus"']]);
  saveWorkspace(proj, ws);
  expect(svc.hasTeamLeadAgentSession(ws.id)).toBe(false);
});

test("hasTeamLeadAgentSession: false for an unknown workspace id", () => {
  const proj = freshProject();
  const svc = new WorkspaceService(minimalDeps(proj));
  expect(svc.hasTeamLeadAgentSession("wsp_does_not_exist")).toBe(false);
});

// ----- restoreFrom()'s new mint loop: session-service.ts imports node-pty,
// not bun-test-importable -- extracted verbatim and executed with the REAL
// resolveMcpConfig/isTeamLeadAgent/agentFromRestoredArgs injected (never
// reimplemented), only mintTeamLeadBridge/reportError stubbed. -----

const RESTORE_LOOP_HEAD = "for (const d of this.defs) {";
const RESTORE_LOOP_NEXT_LINE = "const agent = agentFromRestoredArgs(d.args)";

/**
 * `for (const d of this.defs) {` alone is not unique (5 occurrences in
 * restoreFrom() + create()'s neighbours) -- disambiguated by requiring the
 * very next non-blank line to be the mint-loop's own first statement.
 * Fails closed: 0 or more than 1 qualifying occurrence is refused, never the
 * first one taken silently.
 */
function extractRestoreMintLoopBody(src: string): string {
  const heads = [...src.matchAll(new RegExp(RESTORE_LOOP_HEAD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  const qualifying = heads.filter((m) => src.slice(m.index, m.index + 200).includes(RESTORE_LOOP_NEXT_LINE));
  if (qualifying.length !== 1) {
    throw new Error(
      `session-service.ts: expected exactly 1 restoreFrom() mint-loop occurrence, found ${qualifying.length} -- has it been renamed, duplicated, or reshaped?`
    );
  }
  const m = qualifying[0]!;
  const forOpenIdx = m.index + m[0].length - 1;
  return extractBracedBody(src, forOpenIdx);
}

test("card 6363bd69 wiring: restoreFrom()'s real mint loop grants mcpConfig only to the team-lead-agent def, using the injected real predicates", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const loopBody = extractRestoreMintLoopBody(src);
  const wrapped = `for (const d of this.defs) {${loopBody}}`;

  const mintCalls: string[] = [];
  const mint: MintTeamLeadBridge = () => {
    mintCalls.push("called");
    return { mcpConfig: "/state/team-lead-mcp-xyz.json", callerId: "team-lead-xyz" };
  };
  const reportCalls: unknown[] = [];
  const report = (...args: unknown[]) => reportCalls.push(args);

  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const run = new Function("resolveMcpConfig", "isTeamLeadAgent", "agentFromRestoredArgs", "reportError", wrapped) as (
    resolveMcpConfigFn: typeof resolveMcpConfig,
    isTeamLeadAgentFn: typeof isTeamLeadAgent,
    agentFromRestoredArgsFn: typeof agentFromRestoredArgs,
    reportErrorFn: typeof report
  ) => void;

  const leadDef = { args: '--agent "team-lead"', mcpConfig: undefined as string | undefined };
  const otherDef = { args: '--agent "reviewer"', mcpConfig: undefined as string | undefined };
  const stub = { defs: [leadDef, otherDef], mintTeamLeadBridge: mint };

  run.call(stub, resolveMcpConfig, isTeamLeadAgent, agentFromRestoredArgs, report);

  expect(leadDef.mcpConfig, "the team-lead-agent def must be minted a fresh bridge").toBe(
    "/state/team-lead-mcp-xyz.json"
  );
  expect(otherDef.mcpConfig, "a non-team-lead def must never be minted a bridge").toBeUndefined();
  expect(mintCalls.length).toBe(1);
  expect(reportCalls.length).toBe(0);
});

// ----- ipc.ts's workspace:restore: ensureControlServer() gated on
// hasTeamLeadAgentSession(id), running BEFORE workspaces.restore(...) -----

function checkWorkspaceRestoreWiring(src: string): string | null {
  const handlerAnchor = /regHandle\(\s*'workspace:restore'[\s\S]*?=>\s*\{/;
  const m = handlerAnchor.exec(src);
  if (!m) return "workspace:restore handler not found in ipc.ts -- has it been renamed?";
  const openIdx = m.index + m[0].length - 1;
  let body: string;
  try {
    body = extractBracedBody(src, openIdx);
  } catch (e) {
    return `could not extract the workspace:restore handler body: ${(e as Error).message}`;
  }

  const guardAnchor = "if (workspaces.hasTeamLeadAgentSession(id)) {";
  const guardCount = body.split(guardAnchor).length - 1;
  if (guardCount !== 1) {
    return `workspace:restore: expected exactly 1 occurrence of the hasTeamLeadAgentSession guard, found ${guardCount}`;
  }
  const guardIdx = body.indexOf(guardAnchor);
  const guardOpenIdx = guardIdx + guardAnchor.length - 1;
  let guardBody: string;
  try {
    guardBody = extractBracedBody(body, guardOpenIdx);
  } catch (e) {
    return `could not extract the hasTeamLeadAgentSession guard body: ${(e as Error).message}`;
  }
  if (!/ensureControlServer\(\)/.test(guardBody)) {
    return "workspace:restore's hasTeamLeadAgentSession(id) guard does not call ensureControlServer()";
  }

  const restoreCallIdx = body.indexOf("workspaces.restore(");
  if (restoreCallIdx === -1) return "workspace:restore no longer calls workspaces.restore(...)";
  if (guardIdx > restoreCallIdx) {
    return "workspace:restore's hasTeamLeadAgentSession/ensureControlServer guard must run BEFORE workspaces.restore(...)";
  }
  return null;
}

test("ipc.ts's workspace:restore starts the deck-control endpoint (gated on hasTeamLeadAgentSession) before workspaces.restore(...)", () => {
  const src = readFileSync(IPC_PATH, "utf-8");
  expect(checkWorkspaceRestoreWiring(src)).toBeNull();
});

test("negative control: REJECTS a synthetic handler that never calls ensureControlServer()", () => {
  const mutated = [
    "regHandle('workspace:restore', async (_e, id: string) => {",
    "  if (workspaces.hasTeamLeadAgentSession(id)) {",
    "    // nothing",
    "  }",
    "  const result = workspaces.restore(id, attendance)",
    "})"
  ].join("\n");
  const reason = checkWorkspaceRestoreWiring(mutated);
  expect(reason).not.toBeNull();
  expect(reason).toContain("ensureControlServer");
});

test("negative control: REJECTS a synthetic handler that starts the endpoint unconditionally", () => {
  const mutated = [
    "regHandle('workspace:restore', async (_e, id: string) => {",
    "  await ensureControlServer()",
    "  const result = workspaces.restore(id, attendance)",
    "})"
  ].join("\n");
  const reason = checkWorkspaceRestoreWiring(mutated);
  expect(reason).not.toBeNull();
  expect(reason).toContain("hasTeamLeadAgentSession");
});

test("MUTATION PROOF: REJECTS a handler where the guard runs AFTER workspaces.restore(...)", () => {
  const mutated = [
    "regHandle('workspace:restore', async (_e, id: string) => {",
    "  const result = workspaces.restore(id, attendance)",
    "  if (workspaces.hasTeamLeadAgentSession(id)) {",
    "    await ensureControlServer()",
    "  }",
    "})"
  ].join("\n");
  const reason = checkWorkspaceRestoreWiring(mutated);
  expect(reason).not.toBeNull();
  expect(reason).toContain("BEFORE");
});

test("MUTATION PROOF: REJECTS a handler with two guard occurrences instead of taking the first", () => {
  const mutated = [
    "regHandle('workspace:restore', async (_e, id: string) => {",
    "  if (workspaces.hasTeamLeadAgentSession(id)) {",
    "    await ensureControlServer()",
    "  }",
    "  if (workspaces.hasTeamLeadAgentSession(id)) {",
    "    await ensureControlServer()",
    "  }",
    "  const result = workspaces.restore(id, attendance)",
    "})"
  ].join("\n");
  const reason = checkWorkspaceRestoreWiring(mutated);
  expect(reason).not.toBeNull();
  expect(reason).toContain("expected exactly 1");
});

test("cleanup: temp workspace dirs", () => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  expect(true).toBe(true);
});
