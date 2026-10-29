import { afterAll, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveAgent,
  isTeamLeadAgent,
  resolveMcpConfig,
  wantsDeckLeadPlugin,
  type MintTeamLeadBridge
} from "../desktop/src/main/team-lead-bridge";
import {
  WorkspaceService,
  type WorkspaceDeps
} from "../desktop/src/main/workspace-service";
import { newWorkspaceId, saveWorkspace, type Workspace } from "../desktop/src/main/workspace-store";
import { extractBracedBody } from "./_braced-body";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

// ----- effectiveAgent on a restored SessionDef.args: bounded extraction -----

test("recovers the agent from the exact --agent \"value\" shape create() writes", () => {
  expect(effectiveAgent(undefined, '--agent "team-lead"').agent).toBe("team-lead");
  expect(effectiveAgent(undefined, '--agent "team-lead" --model "opus"').agent).toBe("team-lead");
  expect(effectiveAgent(undefined, '--model "opus" --agent "reviewer" --effort "high"').agent).toBe("reviewer");
});

test("returns undefined, not ambiguous, on zero matches", () => {
  expect(effectiveAgent(undefined, "")).toEqual({ agent: undefined });
  expect(effectiveAgent(undefined, "--model \"opus\"")).toEqual({ agent: undefined });
});

test("takes the LAST canonical --agent, the one the CLI runs, when create() appended an args --agent after the agent field", () => {
  expect(effectiveAgent(undefined, '--agent "developer" --agent "team-lead"').agent).toBe("team-lead");
  expect(effectiveAgent(undefined, '--agent "team-lead" --agent "developer"').agent).toBe("developer");
});

test("reads the legacy unquoted --agent value, the args being a plain token sequence", () => {
  expect(effectiveAgent(undefined, "--agent team-lead")).toEqual({ agent: "team-lead" });
});

test("a glued suffix names another agent than team-lead, so it resolves nothing and reports nothing", () => {
  expect(effectiveAgent(undefined, '--agent "team-lead"x')).toEqual({ agent: undefined });
});

test("is ambiguous on an empty value or a shell separator", () => {
  for (const args of ['--agent "team-lead" --agent ""', '--agent "team-lead" ; true']) {
    const r = effectiveAgent(undefined, args);
    expect(r.agent, args).toBeUndefined();
    expect(r.ambiguity, args).toBeDefined();
  }
});

test("the recovered value round-trips through the SAME isTeamLeadAgent predicate every other route uses", () => {
  expect(isTeamLeadAgent(effectiveAgent(undefined, '--agent "team-lead"').agent)).toBe(true);
  expect(isTeamLeadAgent(effectiveAgent(undefined, '--agent "reviewer"').agent)).toBe(false);
  expect(isTeamLeadAgent(effectiveAgent(undefined, "").agent)).toBe(false);
});

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
    adoptScope: async () => ({ state: "busy" }),
    cancelScopeAdoption: () => {},
    closeScopeAdoption: () => {},
    onCredentialFailure: () => {},
    confirmShellFields: async () => "approved",
    confirmUntrustedCwd: async () => "approved"
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

test("hasTeamLeadAgentSession: true when the team-lead --agent comes last, false when it is overridden or not plain", () => {
  const proj = freshProject();
  const svc = new WorkspaceService(minimalDeps(proj));
  const last = sampleWorkspace([["--agent", '"developer"', "--agent", '"team-lead"']]);
  const overridden = sampleWorkspace([["--agent", '"team-lead"', "--agent", '"developer"']]);
  const notPlain = sampleWorkspace([["--agent", '"team-lead"', ";", "true"]]);
  for (const ws of [last, overridden, notPlain]) saveWorkspace(proj, ws);
  expect(svc.hasTeamLeadAgentSession(last.id)).toBe(true);
  expect(svc.hasTeamLeadAgentSession(overridden.id)).toBe(false);
  expect(svc.hasTeamLeadAgentSession(notPlain.id)).toBe(false);
});

test("hasTeamLeadAgentSession: false for an unknown workspace id", () => {
  const proj = freshProject();
  const svc = new WorkspaceService(minimalDeps(proj));
  expect(svc.hasTeamLeadAgentSession("wsp_does_not_exist")).toBe(false);
});

// ----- restoreFrom()'s new mint loop: session-service.ts imports node-pty,
// not bun-test-importable -- extracted verbatim and executed with the REAL
// resolveMcpConfig/isTeamLeadAgent/effectiveAgent injected (never
// reimplemented), only mintTeamLeadBridge/reportError stubbed. -----

const RESTORE_LOOP_HEAD = "for (const d of this.defs) {";
const RESTORE_LOOP_NEXT_LINE = "const { agent, ambiguity } = effectiveAgent(undefined, d.args)";

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

interface RestoredDefStub {
  id: string;
  name: string;
  args: string;
  mcpConfig: string | undefined;
}

function runRestoreMintLoop(defs: RestoredDefStub[]): {
  mintCalls: number;
  reports: string[];
  mintedCallerIds: Map<string, string>;
} {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const loopBody = extractRestoreMintLoopBody(src);
  const wrapped = `const mintedCallerIds = new Map(); for (const d of this.defs) {${loopBody}} return mintedCallerIds`;

  let mintCalls = 0;
  const mint: MintTeamLeadBridge = () => {
    mintCalls++;
    return { mcpConfig: "/state/team-lead-mcp-xyz.json", callerId: "team-lead-xyz" };
  };
  const reports: string[] = [];
  const report = (_scope: string, message: string) => reports.push(message);

  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const run = new Function(
    "resolveMcpConfig",
    "isTeamLeadAgent",
    "effectiveAgent",
    "wantsDeckLeadPlugin",
    "reportError",
    wrapped
  ) as (
    resolveMcpConfigFn: typeof resolveMcpConfig,
    isTeamLeadAgentFn: typeof isTeamLeadAgent,
    effectiveAgentFn: typeof effectiveAgent,
    wantsDeckLeadPluginFn: typeof wantsDeckLeadPlugin,
    reportErrorFn: typeof report
  ) => Map<string, string>;
  const mintedCallerIds = run.call(
    { defs, mintTeamLeadBridge: mint, deckLeadPluginTiles: new Set<string>(), sandboxBridgeRefusal: () => undefined },
    resolveMcpConfig,
    isTeamLeadAgent,
    effectiveAgent,
    wantsDeckLeadPlugin,
    report
  );
  return { mintCalls, reports, mintedCallerIds };
}

test("restoreFrom()'s real mint loop grants mcpConfig only to the team-lead-agent def, using the injected real predicates", () => {
  const leadDef = { id: "lead", name: "lead", args: '--agent "team-lead"', mcpConfig: undefined as string | undefined };
  const otherDef = { id: "reviewer", name: "rev", args: '--agent "reviewer"', mcpConfig: undefined as string | undefined };

  const r = runRestoreMintLoop([leadDef, otherDef]);

  expect(leadDef.mcpConfig, "the team-lead-agent def must be minted a fresh bridge").toBe(
    "/state/team-lead-mcp-xyz.json"
  );
  expect(otherDef.mcpConfig, "a non-team-lead def must never be minted a bridge").toBeUndefined();
  expect(r.mintedCallerIds).toEqual(new Map([["lead", "team-lead-xyz"]]));
  expect(r.mintCalls).toBe(1);
  expect(r.reports).toEqual([]);
});

test("restoreFrom()'s mint loop follows the last --agent and refuses an ambiguous one with a report naming the session", () => {
  const overriddenToLead = { id: "to-lead", name: "a", args: '--agent "developer" --agent "team-lead"', mcpConfig: undefined as string | undefined };
  const overriddenAway = { id: "away", name: "b", args: '--agent "team-lead" --agent "developer"', mcpConfig: undefined as string | undefined };
  const ambiguous = { id: "ambiguous", name: "hand-edited lead", args: '--agent "team-lead" ; true', mcpConfig: undefined as string | undefined };

  const r = runRestoreMintLoop([overriddenToLead, overriddenAway, ambiguous]);

  expect(overriddenToLead.mcpConfig).toBe("/state/team-lead-mcp-xyz.json");
  expect(overriddenAway.mcpConfig).toBeUndefined();
  expect(ambiguous.mcpConfig).toBeUndefined();
  expect(r.mintCalls).toBe(1);
  expect(r.reports).toHaveLength(1);
  expect(r.reports[0]).toContain("hand-edited lead");
});

test("restoreFrom stores each restored mint in runtime state", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const mapStart = src.indexOf("const mintedCallerIds = new Map<string, string>()");
  expect(mapStart).toBeGreaterThanOrEqual(0);
  const firstLoop = src.indexOf("for (const d of this.defs) {", mapStart);
  const runtimeLoop = src.indexOf("for (const d of this.defs) {", firstLoop + 1);
  expect(runtimeLoop).toBeGreaterThan(firstLoop);
  const open = runtimeLoop + "for (const d of this.defs) ".length;
  const body = extractBracedBody(src, open);
  expect(body).toMatch(/mintedCallerId:\s*mintedCallerIds\.get\(d\.id\)\s*\?\?\s*null/);
});

afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
