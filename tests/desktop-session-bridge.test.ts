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
import { isClodexLaunch, withClodexWrapper } from "../desktop/src/main/session-kind.ts";

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

type Trace = { scope: string; message: string };

function makeBridgedCommand(sandboxPeersDir: string | null): {
  bridgedCommand: (base: string) => string;
  traces: Trace[];
} {
  const body = extractPrivateBody(
    /private bridgedCommand\(base: string\): string \{/,
    "bridgedCommand()"
  );
  const traces: Trace[] = [];
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("base", "withClodexWrapper", "isClodexLaunch", "reportError", body) as (
    this: unknown,
    base: string,
    withClodexWrapperArg: (command: string) => string,
    isClodexLaunchArg: (command: string) => boolean,
    reportErrorArg: (scope: string, message: string) => void
  ) => string;
  const self = { sandboxPeersDir: () => sandboxPeersDir };
  return {
    traces,
    bridgedCommand: (base: string): string =>
      fn.call(self, base, withClodexWrapper, isClodexLaunch, (scope, message) =>
        traces.push({ scope, message })
      )
  };
}

test("sandbox OFF: the claude token of the resolved launch command is rewritten to the wrapper, silently (no anomaly)", () => {
  const { bridgedCommand, traces } = makeBridgedCommand(null);
  expect(bridgedCommand("claude --dangerously-load-development-channels server:claude-peers")).toBe(
    "clodex-claude --dangerously-load-development-channels server:claude-peers"
  );
  expect(traces).toEqual([]);
});

test("sandbox ON: the bridge is dropped, the command is untouched, and the drop is traced (the wrapper and its proxy are HOST-side only)", () => {
  const { bridgedCommand, traces } = makeBridgedCommand("/state/sandbox-peers/kory-sbx-abc");
  expect(bridgedCommand("claude --model opus")).toBe("claude --model opus");
  expect(traces.length).toBe(1);
  expect(traces[0]!.scope).toBe("session");
  expect(traces[0]!.message).toMatch(/sandbox/i);
});

test("no claude binary in the launch command: untouched AND traced -- the operator picked a bridged model and gets a tile that is not bridged", () => {
  const { bridgedCommand, traces } = makeBridgedCommand(null);
  expect(bridgedCommand("./run-agent.sh --whatever")).toBe("./run-agent.sh --whatever");
  expect(traces.length).toBe(1);
  expect(traces[0]!.scope).toBe("session");
});

test("an already-wrapped launch command is a no-op, NOT an anomaly: no trace", () => {
  const { bridgedCommand, traces } = makeBridgedCommand(null);
  expect(bridgedCommand("clodex-claude --model opus")).toBe("clodex-claude --model opus");
  expect(traces).toEqual([]);
});

test("an empty base is traced and returned, never thrown: withClodexWrapper's own empty guard must not escape the spawn path", () => {
  const { bridgedCommand, traces } = makeBridgedCommand(null);
  expect(bridgedCommand("")).toBe("");
  expect(traces.length).toBe(1);
});

// ----- the real resolveBaseCommand() body, run against stubs -----
//
// This is the method that decides, at EVERY spawn, which command a tile starts
// on. Its stub bridgedCommand tags what it receives, so each assertion below
// proves both the decision and the exact string handed to the wrapper.

function makeResolveBaseCommand(launchCommand: string): {
  resolveBaseCommand: (def: { command: string; bridge?: string }) => string;
  wrapped: string[];
} {
  const body = extractPrivateBody(
    /private resolveBaseCommand\(def: SessionDef\): string \{/,
    "resolveBaseCommand()"
  );
  const wrapped: string[] = [];
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("def", body) as (
    this: unknown,
    def: { command: string; bridge?: string }
  ) => string;
  const self = {
    launchCommand,
    bridgedCommand: (base: string): string => {
      wrapped.push(base);
      return `WRAPPED(${base})`;
    }
  };
  return { wrapped, resolveBaseCommand: (def) => fn.call(self, def) };
}

test("no bridge marker: the base is the def's own command, else the CONFIGURED launch command -- and the wrapper is never consulted", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  expect(resolveBaseCommand({ command: "" })).toBe("claude --resume-me");
  expect(resolveBaseCommand({ command: "   " })).toBe("claude --resume-me");
  expect(resolveBaseCommand({ command: "codex --flag" })).toBe("codex --flag");
  expect(wrapped).toEqual([]);
});

test("bridge marker with an empty command: the CONFIGURED launch command is what gets wrapped, resolved fresh at this spawn", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  expect(resolveBaseCommand({ command: "", bridge: "clodex" })).toBe(
    "WRAPPED(claude --resume-me)"
  );
  expect(wrapped).toEqual(["claude --resume-me"]);
});

test("bridge marker with an explicit command: that command is what gets wrapped", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  expect(resolveBaseCommand({ command: "claude --mine", bridge: "clodex" })).toBe(
    "WRAPPED(claude --mine)"
  );
  expect(wrapped).toEqual(["claude --mine"]);
});

// A def is read back from sessions.json and from a repo-cloned workspace file,
// so `bridge` is untrusted at THIS boundary too, not only at create().
test("a bridge marker that is not the exact string is ignored, never wrapped: a persisted def is untrusted input", () => {
  const { resolveBaseCommand, wrapped } = makeResolveBaseCommand("claude --resume-me");
  for (const hostile of ["clodex ", "Clodex", "clodex-evil", "1", ""]) {
    expect(resolveBaseCommand({ command: "claude --mine", bridge: hostile })).toBe("claude --mine");
  }
  expect(wrapped).toEqual([]);
});

// ----- create(): the marker is stored, the command is NOT rewritten -----

/** Exported so a mutation probe can run it against a MUTATED COPY of the real
 * source text without touching the file the test itself reads. */
export function checkCreateBridgeWiring(src: string): string | null {
  const fnMatch = /create\(input: CreateSessionInput[\s\S]*?\): SessionRuntime \{/.exec(src);
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

  const resolverMatch = /private resolveBaseCommand\(def: SessionDef\): string \{/.exec(src);
  if (!resolverMatch) return "private resolveBaseCommand(def: SessionDef): string not found -- has it been renamed?";
  const resolverBody = codeOnly(
    extractBracedBody(src, resolverMatch.index + resolverMatch[0].length - 1)
  );
  if (!resolverBody.includes("def.command.trim()")) {
    return "the file's single raw `def.command.trim()` is NOT the one inside resolveBaseCommand -- some other method owns the resolution";
  }
  if (!/def\.bridge\s*===\s*'clodex'\s*\?\s*this\.bridgedCommand\(/.test(resolverBody)) {
    return "resolveBaseCommand does not gate this.bridgedCommand() on the strict `def.bridge === 'clodex'` marker -- a persisted def is untrusted input";
  }

  const startMatch = /private startPty\(def: SessionDef, mode: SpawnMode\): void \{/.exec(src);
  if (!startMatch) return "private startPty(def: SessionDef, mode: SpawnMode): void not found -- has it been renamed?";
  const startBody = codeOnly(extractBracedBody(src, startMatch.index + startMatch[0].length - 1));
  if (!/const\s+base\s*=\s*this\.resolveBaseCommand\(def\)/.test(startBody)) {
    return "startPty does not take its `base` from this.resolveBaseCommand(def) -- the PTY would be spawned on the unwrapped command";
  }
  if (!/r\.claudeLaunch = isClaudeLaunch\(base\)/.test(startBody)) {
    return "startPty does not freeze r.claudeLaunch from the resolved `base` -- it would answer for a command this tile never ran";
  }

  const claudeMatch = /private resolveClaudeLaunch\(def: SessionDef\): boolean \{/.exec(src);
  if (!claudeMatch) return "private resolveClaudeLaunch(def: SessionDef): boolean not found -- has it been renamed?";
  const claudeBody = codeOnly(
    extractBracedBody(src, claudeMatch.index + claudeMatch[0].length - 1)
  );
  if (!/isClaudeLaunch\(this\.resolveBaseCommand\(def\)\)/.test(claudeBody)) {
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
    "const base = this.resolveBaseCommand(def)",
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
    "  private startPty(def: SessionDef, mode: SpawnMode): void {",
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
    "  private resolveBaseCommand(def: SessionDef): string {",
    "    const base = def.command.trim() || this.launchCommand",
    "    return def.bridge === 'clodex' ? this.bridgedCommand(base) : base",
    "  }",
    "  private startPty(def: SessionDef, mode: SpawnMode): void {",
    "    const base = this.resolveBaseCommand(def)",
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
