// SessionService cannot be instantiated behaviorally (electron + node-pty), so
// the two decisions the clodex bridge rests on live in their own tiny private
// methods whose real bodies are extracted and RUN here: bridgedCommand() (how a
// command is wrapped) and resolveBaseCommand() (when it is). create()'s and
// startPty()'s wiring to them is covered by the source scans below, with
// negative controls.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractBracedBody, extractParenBody } from "./_braced-body";
import {
  isClodexLaunch,
  withClodexWrapper,
  withoutClodexWrapper
} from "../desktop/src/main/session-kind.ts";

const SESSION_SERVICE_PATH = join(
  import.meta.dir,
  "..",
  "desktop",
  "src",
  "main",
  "session-service.ts"
);
const INDEX_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");

/** Comments stripped: the prose around these branches legitimately repeats the
 * very identifiers the scans below count. Index-shifting, so it is applied to a
 * body ALREADY extracted from the raw source, never before an extraction. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*/, ""))
    .join("\n");
}

function assertSingleDeclaration(src: string, pattern: RegExp, label: string): void {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const count = (src.match(global) ?? []).length;
  if (count !== 1) {
    throw new Error(
      `extraction compromised: ${label} matched ${count} time(s) in session-service.ts (expected exactly 1). ` +
        "0 means the extraction below finds nothing, >1 means it silently grabs the WRONG declaration -- either way the " +
        "assertions that follow would stop describing the real bridge decision."
    );
  }
}

function extractPrivateBody(pattern: RegExp, label: string): string {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  assertSingleDeclaration(src, pattern, label);
  const fnMatch = pattern.exec(src)!;
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

// ----- the real bridgedCommand() body, run against stubs -----

type ResolvedCommand = {
  command: string;
  wrapperRemoved: string | null;
  bridgeIssue: string | null;
};

function makeBridgedCommand(sandboxPeersDir: string | null): {
  bridgedCommand: (base: string, sandboxed: boolean) => ResolvedCommand;
} {
  const body = extractPrivateBody(
    /private bridgedCommand\(base: string(?:, sandboxed: boolean)?\): (?:string|ResolvedCommand) \{/,
    "bridgedCommand()"
  );
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("base", "sandboxed", "withClodexWrapper", "isClodexLaunch", "withoutClodexWrapper", body) as (
    this: unknown,
    base: string,
    sandboxed: boolean,
    withClodexWrapperArg: (command: string) => string,
    isClodexLaunchArg: (command: string) => boolean,
    withoutClodexWrapperArg: (command: string) => string
  ) => ResolvedCommand;
  const self = { sandboxPeersDir: () => sandboxPeersDir };
  return {
    bridgedCommand: (base: string, sandboxed: boolean): ResolvedCommand =>
      fn.call(self, base, sandboxed, withClodexWrapper, isClodexLaunch, withoutClodexWrapper)
  };
}

test("sandbox OFF: the claude token of the resolved launch command is rewritten to the wrapper without a trace outcome", () => {
  const { bridgedCommand } = makeBridgedCommand(null);
  expect(bridgedCommand("claude --dangerously-load-development-channels server:claude-peers", false)).toEqual({
    command: "clodex-claude --dangerously-load-development-channels server:claude-peers",
    wrapperRemoved: null,
    bridgeIssue: null
  });
});

test("sandbox ON: a plain bridged tile keeps its command and records one issue outcome", () => {
  const { bridgedCommand } = makeBridgedCommand("/state/sandbox-peers/kory-sbx-abc");
  expect(bridgedCommand("claude --model opus", true)).toEqual({
    command: "claude --model opus",
    wrapperRemoved: null,
    bridgeIssue: "clodex bridge ignored, sandbox mode owns the launch command"
  });
});

test("a bridged command without claude is returned with an issue outcome", () => {
  const { bridgedCommand } = makeBridgedCommand(null);
  expect(bridgedCommand("./run-agent.sh --whatever", false)).toEqual({
    command: "./run-agent.sh --whatever",
    wrapperRemoved: null,
    bridgeIssue: "clodex bridge ignored, no claude binary in the launch command"
  });
});

test("an already-wrapped host launch command has no bridge outcome", () => {
  const { bridgedCommand } = makeBridgedCommand(null);
  expect(bridgedCommand("clodex-claude --model opus", false)).toEqual({
    command: "clodex-claude --model opus",
    wrapperRemoved: null,
    bridgeIssue: null
  });
});

test("an empty bridged command returns an issue outcome without throwing", () => {
  const { bridgedCommand } = makeBridgedCommand(null);
  expect(bridgedCommand("", false)).toEqual({
    command: "",
    wrapperRemoved: null,
    bridgeIssue: "clodex bridge ignored, no launch command resolved to wrap"
  });
});

test("sandbox ON: a bridged tile already using clodex-claude launches claude and records removal once", () => {
  const { bridgedCommand } = makeBridgedCommand("/state/sandbox-peers/kory-sbx-abc");
  expect(bridgedCommand("clodex-claude --model opus", true)).toEqual({
    command: "claude --model opus",
    wrapperRemoved: "bridged tile",
    bridgeIssue: null
  });
});

test("sandbox ON: a bridged supervisor keeps its clodex-claude command without a removal outcome", () => {
  const { bridgedCommand } = makeBridgedCommand("/state/sandbox-peers/kory-sbx-abc");
  expect(bridgedCommand("clodex-claude --model opus", false)).toEqual({
    command: "clodex-claude --model opus",
    wrapperRemoved: null,
    bridgeIssue: null
  });
});

// ----- the real resolveBaseCommand() body, run against stubs -----
//
// This is the method that decides, at EVERY spawn, which command a tile starts
// on. Its stub bridgedCommand tags what it receives, so each assertion below
// proves both the decision and the exact string handed to the wrapper.

function makeResolveBaseCommand(launchCommand: string, sandboxPeersDir: string | null = null): {
  resolveBaseCommand: (def: { command: string; bridge?: string; supervisor?: boolean }) => ResolvedCommand;
  wrapped: string[];
} {
  const body = extractPrivateBody(
    /private resolveBaseCommand\(def: SessionDef\): (?:string|ResolvedCommand) \{/,
    "resolveBaseCommand()"
  );
  const wrapped: string[] = [];
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("def", "isClodexLaunch", "withoutClodexWrapper", "reportError", body) as (
    this: unknown,
    def: { command: string; bridge?: string; supervisor?: boolean },
    isClodexLaunchArg: (command: string) => boolean,
    withoutClodexWrapperArg: (command: string) => string,
    reportErrorArg: () => void
  ) => ResolvedCommand;
  const self = {
    launchCommand,
    sandboxPeersDir: () => sandboxPeersDir,
    runsInSandbox: (def: { supervisor?: boolean }) => !def.supervisor && sandboxPeersDir !== null,
    bridgedCommand: (base: string, _sandboxed?: boolean): ResolvedCommand => {
      wrapped.push(base);
      return { command: `WRAPPED(${base})`, wrapperRemoved: null, bridgeIssue: null };
    }
  };
  return {
    wrapped,
    resolveBaseCommand: (def) => fn.call(self, def, isClodexLaunch, withoutClodexWrapper, () => {})
  };
}

test("no bridge marker: the base is the def's own command, else the CONFIGURED launch command -- and the wrapper is never consulted", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  expect(resolveBaseCommand({ command: "" }).command).toBe("claude --resume-me");
  expect(resolveBaseCommand({ command: "   " }).command).toBe("claude --resume-me");
  expect(resolveBaseCommand({ command: "codex --flag" }).command).toBe("codex --flag");
  expect(wrapped).toEqual([]);
});

test("bridge marker with an empty command: the CONFIGURED launch command is what gets wrapped, resolved fresh at this spawn", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  expect(resolveBaseCommand({ command: "", bridge: "clodex" }).command).toBe(
    "WRAPPED(claude --resume-me)"
  );
  expect(wrapped).toEqual(["claude --resume-me"]);
});

test("sandbox ON: a configured clodex-claude launch command is replaced with claude and records its source", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand(
    "clodex-claude --dangerously-load-development-channels server:claude-peers",
    "/state/sandbox-peers/kory-sbx-abc"
  );
  expect(resolveBaseCommand({ command: "" })).toEqual({
    command: "claude --dangerously-load-development-channels server:claude-peers",
    wrapperRemoved: "configured launch command",
    bridgeIssue: null
  });
  expect(wrapped).toEqual([]);
});

test("sandbox ON: a tile command override through clodex-claude is replaced with claude and records its source", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand(
    "claude --global",
    "/state/sandbox-peers/kory-sbx-abc"
  );
  expect(resolveBaseCommand({ command: "clodex-claude --model opus" })).toEqual({
    command: "claude --model opus",
    wrapperRemoved: "tile command override",
    bridgeIssue: null
  });
  expect(wrapped).toEqual([]);
});

test("sandbox ON: a supervisor keeps its configured clodex-claude command without a removal outcome", () => {
  const { resolveBaseCommand } = makeResolveBaseCommand(
    "clodex-claude --dangerously-load-development-channels server:claude-peers",
    "/state/sandbox-peers/kory-sbx-abc"
  );
  expect(resolveBaseCommand({ command: "", supervisor: true })).toEqual({
    command: "clodex-claude --dangerously-load-development-channels server:claude-peers",
    wrapperRemoved: null,
    bridgeIssue: null
  });
});

test("sandbox ON: plain claude and codex commands remain unchanged without a bridge outcome", () => {
  const { resolveBaseCommand } = makeResolveBaseCommand("claude --global", "/state/sandbox-peers/kory-sbx-abc");
  expect(resolveBaseCommand({ command: "claude --model opus" })).toEqual({
    command: "claude --model opus",
    wrapperRemoved: null,
    bridgeIssue: null
  });
  expect(resolveBaseCommand({ command: "codex --model gpt" })).toEqual({
    command: "codex --model gpt",
    wrapperRemoved: null,
    bridgeIssue: null
  });
});

test("sandbox OFF: a configured clodex-claude launch command remains unchanged", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("clodex-claude --model opus");
  expect(resolveBaseCommand({ command: "" })).toEqual({
    command: "clodex-claude --model opus",
    wrapperRemoved: null,
    bridgeIssue: null
  });
  expect(wrapped).toEqual([]);
});

test("bridge marker with an explicit command: that command is what gets wrapped", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  expect(resolveBaseCommand({ command: "claude --mine", bridge: "clodex" }).command).toBe(
    "WRAPPED(claude --mine)"
  );
  expect(wrapped).toEqual(["claude --mine"]);
});

// A def is read back from sessions.json and from a repo-cloned workspace file,
// so `bridge` is untrusted at THIS boundary too, not only at create().
test("a bridge marker that is not the exact string is ignored, never wrapped: a persisted def is untrusted input", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  for (const hostile of ["clodex ", "Clodex", "clodex-evil", "1", ""]) {
    expect(resolveBaseCommand({ command: "claude --mine", bridge: hostile }).command).toBe("claude --mine");
  }
  expect(wrapped).toEqual([]);
});

// ----- create(): the marker is stored, the command is NOT rewritten -----

/** Exported so a mutation probe can run it against a MUTATED COPY of the real
 * source text without touching the file the test itself reads. */
export function checkCreateBridgeWiring(src: string): string | null {
  const fnMatch = /create\(\s*input:\s*CreateSessionInput[\s\S]*?\):\s*SessionRuntime\s*\{/.exec(src);
  if (!fnMatch) {
    return "create(input: CreateSessionInput, ...): SessionRuntime not found in session-service.ts -- has its signature changed?";
  }
  const body = codeOnly(extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1));

  const reads = (body.match(/input\.bridge\b/g) ?? []).length;
  if (reads !== 1) {
    return `expected exactly one read of input.bridge in create(), found ${reads} -- a companion-supplied value must be consumed ONCE, by the strict enum comparison, never forwarded or tested for truthiness`;
  }
  if (!/const\s+bridge\s*=\s*input\.bridge\s*===\s*'clodex'\s*\?/.test(body)) {
    return "input.bridge is not re-validated as the strict enum `input.bridge === 'clodex'` -- any other value would reach the launch-command rewrite";
  }
  if (/bridgedCommand\(/.test(body)) {
    return "create() wraps the launch command itself -- the wrapper must be applied at every spawn (resolveBaseCommand), never frozen into def.command, which stops following the configured launch command and is dropped by the workspace round-trip";
  }

  const defMatch = /const def: SessionDef = \{/.exec(body);
  if (!defMatch) return "`const def: SessionDef = {` literal not found in create()";
  const defBody = extractBracedBody(body, defMatch.index + defMatch[0].length - 1);
  if (!/^\s*bridge\s*(,|:\s*bridge\b)/m.test(defBody)) {
    return "SessionDef literal does not carry the validated `bridge` marker -- the operator's bridged tile would spawn, persist and restore as a plain claude one";
  }
  if (!/^\s*command:\s*input\.command\?\.trim\(\)\s*\|\|\s*''/m.test(defBody)) {
    return "SessionDef.command is not the operator's own override verbatim -- anything else there is a launch command frozen at create() time";
  }

  return null;
}

test("session-service.ts::create() re-validates input.bridge as a strict enum and stores it as a marker, leaving command alone", () => {
  expect(checkCreateBridgeWiring(readFileSync(SESSION_SERVICE_PATH, "utf-8"))).toBeNull();
});

test("negative control: the checker REJECTS a truthiness test on input.bridge", () => {
  const mutated = [
    "class X {",
    "  create(input: CreateSessionInput, opts?: any): SessionRuntime {",
    "    const bridge = input.bridge ? 'clodex' : undefined",
    "    const def: SessionDef = {",
    "      command: input.command?.trim() || '',",
    "      bridge,",
    "    }",
    "  }",
    "}"
  ].join("\n");
  expect(checkCreateBridgeWiring(mutated)).toMatch(/strict enum/);
});

test("negative control: the checker REJECTS a command frozen at create() time", () => {
  const mutated = [
    "class X {",
    "  create(input: CreateSessionInput, opts?: any): SessionRuntime {",
    "    const bridge = input.bridge === 'clodex' ? 'clodex' : undefined",
    "    const command = bridge ? this.bridgedCommand(input.command?.trim() || this.launchCommand) : ''",
    "    const def: SessionDef = {",
    "      command,",
    "      bridge,",
    "    }",
    "  }",
    "}"
  ].join("\n");
  expect(checkCreateBridgeWiring(mutated)).toMatch(/every spawn/);
});

test("negative control: the checker REJECTS a validated marker that never reaches SessionDef", () => {
  const mutated = [
    "class X {",
    "  create(input: CreateSessionInput, opts?: any): SessionRuntime {",
    "    const bridge = input.bridge === 'clodex' ? 'clodex' : undefined",
    "    const def: SessionDef = {",
    "      command: input.command?.trim() || '',",
    "      cwd: input.cwd,",
    "    }",
    "  }",
    "}"
  ].join("\n");
  expect(checkCreateBridgeWiring(mutated)).toMatch(/does not carry/);
});

// ----- the spawn path: ONE resolution point, and everyone uses it -----

export function checkSpawnBridgeWiring(src: string): string | null {
  const stripped = codeOnly(src);
  const raw = (stripped.match(/def\.command\.trim\(\)/g) ?? []).length;
  if (raw !== 1) {
    return `expected exactly one raw \`def.command.trim()\` resolution in session-service.ts, found ${raw} -- every spawn path must resolve through resolveBaseCommand, or a bridged tile silently starts on the unwrapped binary at that one path`;
  }

  const resolverMatch = /private resolveBaseCommand\(def: SessionDef\): (?:string|ResolvedCommand) \{/.exec(src);
  if (!resolverMatch) return "private resolveBaseCommand(def: SessionDef) not found -- has it been renamed?";
  const resolverBody = codeOnly(
    extractBracedBody(src, resolverMatch.index + resolverMatch[0].length - 1)
  );
  if (!resolverBody.includes("def.command.trim()")) {
    return "the file's single raw `def.command.trim()` is NOT the one inside resolveBaseCommand -- some other method owns the resolution";
  }
  if (!/if\s*\(def\.bridge\s*===\s*'clodex'\)\s*return\s*this\.bridgedCommand\(base, sandboxed\)/.test(resolverBody)) {
    return "resolveBaseCommand does not gate this.bridgedCommand() on the strict `def.bridge === 'clodex'` marker -- a persisted def is untrusted input";
  }
  if (!/const\s+sandboxed\s*=\s*this\.runsInSandbox\(def\)/.test(resolverBody)) {
    return "resolveBaseCommand does not derive sandboxed from the shared tile predicate";
  }

  const startMatch = /private startPty\(def: SessionDef, mode: SpawnMode, modPlan\?: LaunchModPlan\): void \{/.exec(src);
  if (!startMatch) return "private startPty(def: SessionDef, mode: SpawnMode, modPlan?: LaunchModPlan): void not found -- has it been renamed?";
  const startBody = codeOnly(extractBracedBody(src, startMatch.index + startMatch[0].length - 1));
  if (!/const\s+resolved\s*=\s*this\.resolveBaseCommand\(def\)/.test(startBody)) {
    return "startPty does not resolve its command through this.resolveBaseCommand(def) -- the PTY would be spawned on the unwrapped command";
  }
  if (!/const\s+base\s*=\s*resolved\.command/.test(startBody)) {
    return "startPty does not take its base command from the pure resolver result -- the PTY would not run the resolved command";
  }
  if (!/const\s+sandboxed\s*=\s*this\.runsInSandbox\(def\)/.test(startBody)) {
    return "startPty does not reuse the shared tile sandbox predicate";
  }
  if (!/r\.claudeLaunch = isClaudeLaunch\(base\)/.test(startBody)) {
    return "startPty does not freeze r.claudeLaunch from the resolved `base` -- it would answer for a command this tile never ran";
  }
  if (!/if\s*\(resolved\.wrapperRemoved\)\s*\{\s*reportError\('session', `clodex bridge removed from \$\{resolved\.wrapperRemoved\} for sandbox launch`\)\s*\}/.test(startBody)) {
    return "startPty does not trace the wrapper removal from its source only -- the trace may leak a launch command or happen before the spawn";
  }
  if (!/else if\s*\(resolved\.bridgeIssue\)\s*\{\s*reportError\('session', resolved\.bridgeIssue\)\s*\}/.test(startBody)) {
    return "startPty does not emit at most one bridge outcome per spawn";
  }
  if (/reportError\(/.test(resolverBody)) {
    return "resolveBaseCommand reports directly -- repeated pre-spawn reads would duplicate a trace";
  }

  const bridgedMatch = /private bridgedCommand\(base: string, sandboxed: boolean\): ResolvedCommand \{/.exec(src);
  if (!bridgedMatch) return "private bridgedCommand(base: string, sandboxed: boolean) not found -- has it been renamed?";
  const bridgedBody = codeOnly(extractBracedBody(src, bridgedMatch.index + bridgedMatch[0].length - 1));
  if (/reportError\(/.test(bridgedBody)) {
    return "bridgedCommand reports directly -- resolveBaseCommand must stay pure";
  }

  const claudeMatch = /private resolveClaudeLaunch\(def: SessionDef\): boolean \{/.exec(src);
  if (!claudeMatch) return "private resolveClaudeLaunch(def: SessionDef): boolean not found -- has it been renamed?";
  const claudeBody = codeOnly(
    extractBracedBody(src, claudeMatch.index + claudeMatch[0].length - 1)
  );
  if (!/isClaudeLaunch\(this\.resolveBaseCommand\(def\)\.command\)/.test(claudeBody)) {
    return "resolveClaudeLaunch answers from something other than the fully-resolved command -- the seeded claudeLaunch would describe a command no tile runs";
  }

  return null;
}

test("session-service.ts: resolveBaseCommand is the ONLY place a def's command is resolved, and both spawn-time readers go through it", () => {
  expect(checkSpawnBridgeWiring(readFileSync(SESSION_SERVICE_PATH, "utf-8"))).toBeNull();
});

test("negative control: the checker REJECTS a second raw resolution outside resolveBaseCommand", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const mutated = src.replace(
    "const base = resolved.command",
    "const base = def.command.trim() || this.launchCommand"
  );
  expect(mutated).not.toBe(src);
  expect(checkSpawnBridgeWiring(mutated)).toMatch(/exactly one raw/);
});

test("negative control: the checker REJECTS an ungated wrap (every tile bridged)", () => {
  const mutated = [
    "class X {",
    "  private resolveBaseCommand(def: SessionDef): string {",
    "    const base = def.command.trim() || this.launchCommand",
    "    return this.bridgedCommand(base)",
    "  }",
    "  private startPty(def: SessionDef, mode: SpawnMode, modPlan?: LaunchModPlan): void {",
    "    const base = this.resolveBaseCommand(def)",
    "    r.claudeLaunch = isClaudeLaunch(base)",
    "  }",
    "  private resolveClaudeLaunch(def: SessionDef): boolean {",
    "    return isClaudeLaunch(this.resolveBaseCommand(def))",
    "  }",
    "}"
  ].join("\n");
  expect(checkSpawnBridgeWiring(mutated)).toMatch(/strict `def.bridge/);
});

test("negative control: the checker REJECTS claudeLaunch answered from the pre-bridge command", () => {
  const mutated = [
    "class X {",
    "  private resolveBaseCommand(def: SessionDef): ResolvedCommand {",
    "    const base = def.command.trim() || this.launchCommand",
    "    const sandboxed = this.runsInSandbox(def)",
    "    if (def.bridge === 'clodex') return this.bridgedCommand(base, sandboxed)",
    "    return { command: base, wrapperRemoved: null, bridgeIssue: null }",
    "  }",
    "  private bridgedCommand(base: string, sandboxed: boolean): ResolvedCommand {",
    "    return { command: base, wrapperRemoved: null, bridgeIssue: null }",
    "  }",
    "  private startPty(def: SessionDef, mode: SpawnMode, modPlan?: LaunchModPlan): void {",
    "    const resolved = this.resolveBaseCommand(def)",
    "    const base = resolved.command",
    "    const sandboxed = this.runsInSandbox(def)",
    "    if (resolved.wrapperRemoved) { reportError('session', `clodex bridge removed from ${resolved.wrapperRemoved} for sandbox launch`) }",
    "    else if (resolved.bridgeIssue) { reportError('session', resolved.bridgeIssue) }",
    "    r.claudeLaunch = isClaudeLaunch(base)",
    "  }",
    "  private resolveClaudeLaunch(def: SessionDef): boolean {",
    "    return isClaudeLaunch(def.command || this.launchCommand)",
    "  }",
    "}"
  ].join("\n");
  expect(checkSpawnBridgeWiring(mutated)).toMatch(/fully-resolved command/);
});

// bridgedCommand's sandbox answer is only as good as the closure index.ts
// injects: without that third argument the service's default (`() => null`)
// reads as "sandbox off" and a sandboxed tile would be handed a host wrapper
// binary the container cannot resolve.
test("index.ts wires the sandbox-enabled peers-dir closure into setSandboxProvider, which is what bridgedCommand reads as 'sandbox is on'", () => {
  const src = readFileSync(INDEX_PATH, "utf-8");
  const callMatches = [...src.matchAll(/service\.setSandboxProvider\(/g)];
  expect(callMatches.length).toBe(1);
  const call = callMatches[0]!;
  const argsText = extractParenBody(src, call.index + call[0].length - 1, true);
  expect(argsText).toContain("sandbox.isEnabled()");
  expect(argsText).toContain("sandbox.peersDirHost");
});
