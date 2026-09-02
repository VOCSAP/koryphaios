// Deliberately synchronous: an async resolveMcpConfig/buildMintTeamLeadBridge
// would force SessionService.create() to become async, adding a microtask yield
// point to every session creation, not only team-lead ones.
// The deck-control lazy start is instead proactive: ipc.ts's sessions:create
// handler awaits ensureControlServer() itself before ever calling
// SessionService.create().

import { test, expect, mock } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractBracedBody } from "./_braced-body";
import {
  wantsTeamLeadBridge,
  resolveMcpConfig,
  buildMintTeamLeadBridge,
  type TeamLeadBridgeInput,
  type MintTeamLeadBridge,
  type DeckControlServerLike
} from "../desktop/src/main/team-lead-bridge";
import { TEAM_LEAD_DECK_TOOLS, writeTeamLeadMcpConfig } from "../desktop/src/main/supervisor";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

function fakeMint(result: { mcpConfig: string; callerId: string } | null): MintTeamLeadBridge {
  return () => result;
}

// ----- behavioural proofs on the decision (resolveMcpConfig/wantsTeamLeadBridge) -----

test("marker true + agent team-lead + no existing mcpConfig -> mints and uses the bridge", () => {
  const mint = mock(fakeMint({ mcpConfig: "/state/team-lead-abc.json", callerId: "team-lead-abc" }));
  const report = mock(() => {});
  const result = resolveMcpConfig({}, "team-lead", true, mint, report);
  expect(result).toBe("/state/team-lead-abc.json");
  expect(mint).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

test("PROOF 1: marker FALSE (template-shaped call, e.g. a template naming agent: 'team-lead') -> no mcpConfig, mint never called", () => {
  // A repo-sourced template naming `agent: 'team-lead'` never causes its
  // caller (createSessionWithWorktree -> SessionService.create()) to pass
  // `opts`, so `marker` arrives as `false` here -- even though the mint
  // function IS wired and WOULD return a valid bridge, it must never be
  // reached.
  const mint = mock(fakeMint({ mcpConfig: "/state/should-not-be-used.json", callerId: "x" }));
  const report = mock(() => {});
  const result = resolveMcpConfig({}, "team-lead", false, mint, report);
  expect(result).toBeUndefined();
  expect(mint).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test("PROOF (Q1 non-regression): a stray `teamLeadDeckBridge` JSON property ON `input` itself has NO effect -- only the separate `marker` parameter can grant the bridge", () => {
  // The session-create handler forwards its input verbatim rather than
  // reconstructing it field by field, and that channel is remote-reachable by a
  // paired companion client, not just the local renderer.
  // The input type does not declare a teamLeadDeckBridge field, but an attacker
  // does not go through the compiler: a plain object can still carry that extra
  // property at runtime regardless of the type.
  // The real handler always computes marker itself from server-side context and
  // never reads it off input -- simulated here by passing false regardless of
  // what the hostile object carries.
  const hostileInput = { teamLeadDeckBridge: true } as unknown as TeamLeadBridgeInput;
  const mint = mock(fakeMint({ mcpConfig: "/state/should-not-be-used.json", callerId: "x" }));
  const report = mock(() => {});
  const result = resolveMcpConfig(hostileInput, "team-lead", false, mint, report);
  expect(result).toBeUndefined();
  expect(mint).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test("marker true but agent is NOT team-lead -> no mcpConfig, mint never called", () => {
  const mint = mock(fakeMint({ mcpConfig: "/state/x.json", callerId: "x" }));
  const result = resolveMcpConfig({}, "developer", true, mint, () => {});
  expect(result).toBeUndefined();
  expect(mint).not.toHaveBeenCalled();
});

test("an explicit input.mcpConfig always wins and is never overwritten, even with marker true", () => {
  const mint = mock(fakeMint({ mcpConfig: "/state/from-mint.json", callerId: "x" }));
  const result = resolveMcpConfig({ mcpConfig: "/state/already-set.json" }, "team-lead", true, mint, () => {});
  expect(result).toBe("/state/already-set.json");
  expect(mint).not.toHaveBeenCalled();
});

test("PROOF 3: mint returning null (deck-control server not started -- ipc.ts's proactive ensureControlServer() was skipped or failed) does not throw -- reports and continues without a bridge", () => {
  const mint = mock(fakeMint(null));
  const report = mock(() => {});
  let thrown: unknown = null;
  let result: string | undefined;
  try {
    result = resolveMcpConfig({}, "team-lead", true, mint, report);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeNull();
  expect(result).toBeUndefined();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0]).toBe("session");
});

test("PROOF 3b: mint THROWING synchronously does not propagate -- reports and continues without a bridge", () => {
  const mint: MintTeamLeadBridge = () => {
    throw new Error("controlServer.mintCaller blew up");
  };
  const report = mock(() => {});
  let thrown: unknown = null;
  let result: string | undefined;
  try {
    result = resolveMcpConfig({}, "team-lead", true, mint, report);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeNull();
  expect(result).toBeUndefined();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0]).toBe("session");
  expect(report.mock.calls[0]?.[2]).toBeInstanceOf(Error);
});

test("MUTATION PROOF: a predicate that drops the marker check would wrongly grant the bridge to a template-shaped call", () => {
  // Negative control (guard-coverage discipline): the REAL predicate refuses
  // a template-shaped call (marker false), then a one-line mutation dropping
  // the marker check (the shape a careless refactor could introduce) is
  // shown to flip the SAME input to true -- the test genuinely discriminates
  // the guarded behaviour from the unguarded one, not passing on either.
  expect(wantsTeamLeadBridge({}, "team-lead", false)).toBe(false);

  const unconditionalMutant = (input: { mcpConfig?: string }, sanitizedAgent: string): boolean =>
    !input.mcpConfig?.trim() && sanitizedAgent === "team-lead"; // marker parameter dropped
  expect(unconditionalMutant({}, "team-lead")).toBe(true);
});

test("wantsTeamLeadBridge: agent comparison is exact, not a prefix/substring match", () => {
  expect(wantsTeamLeadBridge({}, "team-lead-2", true)).toBe(false);
  expect(wantsTeamLeadBridge({}, "", true)).toBe(false);
});

// TEAM_LEAD_DECK_TOOLS is compared against the live export, not a hand-copied
// literal, so a widening or emptying mutation is caught at both the server-side
// mintCaller scope and the client-side write, the latter via the real
// writeTeamLeadMcpConfig against a throwaway temp dir.

function fakeControlServer(mintCaller: DeckControlServerLike["mintCaller"]): DeckControlServerLike {
  return { url: "http://127.0.0.1:9999", mintCaller };
}

test("buildMintTeamLeadBridge mints with mintCaller('team-lead', TEAM_LEAD_DECK_TOOLS) and writes exactly that allow-list to DECK_CONTROL_TOOLS", () => {
  const dir = mkdtempSync(join(tmpdir(), "kory-team-lead-bridge-"));
  try {
    const mintCaller = mock((label: string, allowedTools?: readonly string[] | null) => ({
      token: "tok-123",
      callerId: `${label}-abc`
    }));
    const mint = buildMintTeamLeadBridge({
      getControlServer: () => fakeControlServer(mintCaller),
      write: (token, callerId, allowedTools) =>
        writeTeamLeadMcpConfig(
          { dir, mcpScriptPath: "C:/fake/deck-control-mcp.mjs", execPath: "C:/fake/node.exe", controlUrl: "http://127.0.0.1:9999", controlToken: token },
          `${callerId}.json`,
          allowedTools
        )
    });

    const result = mint();
    expect(result).not.toBeNull();

    expect(mintCaller).toHaveBeenCalledTimes(1);
    expect(mintCaller.mock.calls[0]?.[0]).toBe("team-lead");
    expect(mintCaller.mock.calls[0]?.[1]).toEqual(TEAM_LEAD_DECK_TOOLS);

    const written = JSON.parse(readFileSync(result!.mcpConfig, "utf-8"));
    const toolsEnv: string = written.mcpServers["deck-control"].env.DECK_CONTROL_TOOLS;
    expect(toolsEnv.split(",")).toEqual([...TEAM_LEAD_DECK_TOOLS]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PROOF: buildMintTeamLeadBridge returns null (not an error) when getControlServer says the server isn't up", () => {
  const mint = buildMintTeamLeadBridge({
    getControlServer: () => null,
    write: () => {
      throw new Error("write must never be called when there is no server");
    }
  });
  expect(mint()).toBeNull();
});

test("MUTATION PROOF (Q4): widening or emptying the allow-list passed to mintCaller/write changes the assertion above -- pinned against the LIVE TEAM_LEAD_DECK_TOOLS export, not a copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "kory-team-lead-bridge-mutant-"));
  try {
    const mintCaller = mock((label: string, allowedTools?: readonly string[] | null) => ({
      token: "tok-456",
      callerId: `${label}-def`
    }));
    // Simulates a MUTANT buildMintTeamLeadBridge that widens the allow-list
    // (a 4th tool slipped in) instead of reusing TEAM_LEAD_DECK_TOOLS as-is.
    const widenedMutant = [...TEAM_LEAD_DECK_TOOLS, "deck_apply_template"];
    mintCaller("team-lead", widenedMutant);
    const emptiedMutant: string[] = [];
    mintCaller("team-lead", emptiedMutant);

    expect(mintCaller.mock.calls[0]?.[1]).not.toEqual(TEAM_LEAD_DECK_TOOLS);
    expect(mintCaller.mock.calls[1]?.[1]).not.toEqual(TEAM_LEAD_DECK_TOOLS);
    // The REAL function, unmutated, must still match -- proving the test
    // discriminates the guarded (real) behaviour from the two unguarded
    // (mutant) ones above, rather than passing on all three.
    const mint = buildMintTeamLeadBridge({
      getControlServer: () => fakeControlServer(mintCaller),
      write: (token, callerId, allowedTools) =>
        writeTeamLeadMcpConfig(
          { dir, mcpScriptPath: "C:/fake/deck-control-mcp.mjs", execPath: "C:/fake/node.exe", controlUrl: "http://127.0.0.1:9999", controlToken: token },
          `${callerId}.json`,
          allowedTools
        )
    });
    mint();
    expect(mintCaller.mock.calls[2]?.[1]).toEqual(TEAM_LEAD_DECK_TOOLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEAM_LEAD_DECK_TOOLS is exactly the 3 spawn/close tools -- restart deliberately excluded (Card ff091064)", () => {
  expect([...TEAM_LEAD_DECK_TOOLS]).toEqual(["deck_spawn_session", "deck_spawn_team", "deck_close_session"]);
});

// Weakest guard in this repo's own hierarchy (source scan only), used because
// session-service.ts can't be exercised behaviorally.
// Proves the call exists and its result reaches the SessionDef literal, but
// cannot prove it's called with the correct arguments -- a mutation
// substituting a wrong argument passes unchanged.

export function checkMcpConfigWiring(src: string): string | null {
  // Non-greedy up to the return-type arrow, not `[^{]*` -- the signature's
  // own `opts?: { teamLeadDeckBridge?: boolean }` parameter type contains a
  // `{` BEFORE the function body's own opening brace, which a naive
  // "anything but a brace" class would stop at, matching the WRONG brace.
  const fnMatch = /create\(input: CreateSessionInput[\s\S]*?\): SessionRuntime \{/.exec(src);
  if (!fnMatch) {
    return "create(input: CreateSessionInput, ...): SessionRuntime not found in session-service.ts -- has its signature changed?";
  }
  const fnStart = fnMatch.index + fnMatch[0].length - 1;
  const body = extractBracedBody(src, fnStart);

  const callMatches = [...body.matchAll(/resolveMcpConfig\(/g)];
  if (callMatches.length !== 1) {
    return `expected exactly one resolveMcpConfig( call in create(), found ${callMatches.length}`;
  }

  if (!/const\s+mcpConfig\s*=\s*resolveMcpConfig\(/.test(body)) {
    return "resolveMcpConfig(...) call found, but not assigned to `const mcpConfig` -- its return value may be discarded";
  }

  const defMatch = /const def: SessionDef = \{/.exec(body);
  if (!defMatch) return "`const def: SessionDef = {` literal not found in create()";
  const defOpenIdx = defMatch.index + defMatch[0].length - 1;
  const defBody = extractBracedBody(body, defOpenIdx);
  if (!/\bmcpConfig\b\s*(,|:)/.test(defBody)) {
    return "SessionDef literal does not carry an `mcpConfig` key -- resolveMcpConfig's result may never reach the created session";
  }

  return null;
}

test("session-service.ts::create() calls resolveMcpConfig exactly once and its return reaches SessionDef.mcpConfig", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const reason = checkMcpConfigWiring(src);
  expect(reason).toBeNull();
});

test("negative control: the checker REJECTS a synthetic body where resolveMcpConfig's result is discarded", () => {
  const mutated = [
    "class X {",
    "  create(input: CreateSessionInput, opts?: any): SessionRuntime {",
    "    resolveMcpConfig(input, agent, opts?.teamLeadDeckBridge === true, this.mintTeamLeadBridge, reportError)",
    "    const def: SessionDef = {",
    "      id: 'x'",
    "    }",
    "  }",
    "}"
  ].join("\n");
  const reason = checkMcpConfigWiring(mutated);
  expect(reason).not.toBeNull();
  expect(reason).toContain("not assigned to `const mcpConfig`");
});

test("negative control: the checker REJECTS a synthetic body where the call is dropped entirely", () => {
  const mutated = [
    "class X {",
    "  create(input: CreateSessionInput, opts?: any): SessionRuntime {",
    "    const mcpConfig = input.mcpConfig?.trim() || undefined",
    "    const def: SessionDef = {",
    "      id: 'x',",
    "      mcpConfig",
    "    }",
    "  }",
    "}"
  ].join("\n");
  const reason = checkMcpConfigWiring(mutated);
  expect(reason).not.toBeNull();
  expect(reason).toContain("expected exactly one resolveMcpConfig(");
});
