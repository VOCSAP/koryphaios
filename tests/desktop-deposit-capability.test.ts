import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IPty } from "node-pty";
import { extractBracedBody } from "./_braced-body";
import { DEPOSIT_CAPABILITY_ENV as CORE_NAME } from "../shared/context-buffer.ts";
import { DEPOSIT_CAPABILITY_ENV, mintDepositCapability } from "../desktop/src/main/deposit-capability.ts";
import { PtyManager } from "../desktop/src/main/pty-manager.ts";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");
const PTY_RUN_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "pty-run.ts");
const HEX64 = /^[0-9a-f]{64}$/;

test("the Deck exports the capability under the exact name the core reads", () => {
  expect(DEPOSIT_CAPABILITY_ENV).toBe(CORE_NAME);
});

test("each mint is 64 lowercase hex and never repeats", () => {
  const minted = new Set(Array.from({ length: 50 }, () => mintDepositCapability()));
  expect(minted.size).toBe(50);
  for (const value of minted) expect(value).toMatch(HEX64);
});

function startPtyBody(source: string): string {
  const match = /private startPty\(def: SessionDef, mode: SpawnMode\): void \{/.exec(source);
  if (!match) throw new Error("startPty not found");
  return extractBracedBody(source, match.index + match[0].length - 1);
}

/** Runs the real sessionEnv literal of startPty with stub inputs. */
function executeSessionEnvLiteral(source: string): Record<string, string> {
  const body = startPtyBody(source);
  const at = body.indexOf("const sessionEnv = {");
  if (at < 0) throw new Error("sessionEnv literal not found");
  const literal = extractBracedBody(body, body.indexOf("{", at));
  const run = new Function("def", "koryModuleServed", "fallbackInjected", `return {${literal}};`) as (
    def: { id: string; role?: string },
    koryModuleServed: boolean,
    fallbackInjected: boolean
  ) => Record<string, string>;
  return run.call({ getScopeEnv: () => ({}) }, { id: "tile-1" }, false, false);
}

/** Runs the real minting statement of startPty with the real mint. */
function executeMint(source: string, sandboxed: boolean, base: string): Record<string, string> {
  const body = startPtyBody(source);
  const lines = body.split("\n").filter((l) => l.includes(`sessionEnv.${DEPOSIT_CAPABILITY_ENV} = mintDepositCapability()`));
  if (lines.length !== 1) throw new Error(`expected exactly one minting statement, found ${lines.length}`);
  const run = new Function("sandboxed", "base", "sessionEnv", "isClaudeLaunch", "mintDepositCapability", `${lines[0]}\nreturn sessionEnv;`) as (
    sandboxed: boolean,
    base: string,
    sessionEnv: Record<string, string>,
    isClaudeLaunch: (value: string) => boolean,
    mint: () => string
  ) => Record<string, string>;
  return run(sandboxed, base, executeSessionEnvLiteral(source), (value) => value === "claude", mintDepositCapability);
}

test("startPty always emits the key, empty by default", () => {
  const env = executeSessionEnvLiteral(readFileSync(SESSION_SERVICE_PATH, "utf8"));
  expect(env[DEPOSIT_CAPABILITY_ENV]).toBe("");
});

test("only a host Claude launch receives a capability, distinct at every startPty", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const first = executeMint(source, false, "claude")[DEPOSIT_CAPABILITY_ENV];
  const second = executeMint(source, false, "claude")[DEPOSIT_CAPABILITY_ENV];
  expect(first).toMatch(HEX64);
  expect(second).toMatch(HEX64);
  expect(second).not.toBe(first);
  expect(executeMint(source, true, "claude")[DEPOSIT_CAPABILITY_ENV]).toBe("");
  expect(executeMint(source, false, "bash")[DEPOSIT_CAPABILITY_ENV]).toBe("");
});

test("the mint harness turns red when the sandbox gate is removed from the real source", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const mutated = source.replace(
    `if (!sandboxed && isClaudeLaunch(base)) sessionEnv.${DEPOSIT_CAPABILITY_ENV} = mintDepositCapability()`,
    `if (isClaudeLaunch(base)) sessionEnv.${DEPOSIT_CAPABILITY_ENV} = mintDepositCapability()`
  );
  expect(mutated).not.toBe(source);
  expect(executeMint(mutated, true, "claude")[DEPOSIT_CAPABILITY_ENV]).toMatch(HEX64);
});

test("utility PTYs receive an empty capability", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const match = /spawnUtility\(id: string, cwd: string, opts: \{ command: string; shell: string; interactive: boolean \}\): void \{/.exec(source);
  if (!match) throw new Error("spawnUtility not found");
  const run = new Function("id", "cwd", "opts", extractBracedBody(source, match.index + match[0].length - 1));
  let received: Record<string, string> | null = null;
  run.call(
    { pty: { spawn: (_i: string, _c: string, _o: unknown, env: Record<string, string>) => (received = env) } },
    "utility",
    "C:/repo",
    { command: "bash", shell: "bash", interactive: false }
  );
  expect(received).not.toBeNull();
  expect(received![DEPOSIT_CAPABILITY_ENV]).toBe("");
});

test("a sandboxed launch never carries a capability: the container env is captured before any mint", () => {
  const source = readFileSync(SESSION_SERVICE_PATH, "utf8");
  const body = startPtyBody(source);
  const wrapAt = body.indexOf("command = wrapper.wrap(def.id, def.sessionId, command, def.cwd, sessionEnv)");
  const mintAt = body.indexOf(`sessionEnv.${DEPOSIT_CAPABILITY_ENV} = mintDepositCapability()`);
  expect(wrapAt).toBeGreaterThan(0);
  expect(mintAt).toBeGreaterThan(0);
  expect(
    wrapAt < mintAt,
    "the sandbox wrapper must receive sessionEnv before the capability is minted, or a mint that ever ran for a sandboxed tile would reach the container"
  ).toBe(true);

  // Same order, executed: the wrapper snapshots the env it is given, then the
  // mint runs with its gate forced open.
  const env = executeSessionEnvLiteral(source);
  const containerEnv = { ...env };
  env[DEPOSIT_CAPABILITY_ENV] = mintDepositCapability();
  expect(containerEnv[DEPOSIT_CAPABILITY_ENV]).toBe("");
});

test("one-shot PTY commands clear an inherited capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "deposit-capability-pty-run-"));
  const probe = join(dir, "pty-run.test.ts");
  writeFileSync(
    probe,
    `import { expect, mock, test } from "bun:test";
let capability = "unset";
mock.module("node-pty", () => ({
  spawn: (_file: string, _args: string[], options: { env: Record<string, string> }) => {
    capability = options.env.${DEPOSIT_CAPABILITY_ENV};
    return { onData: () => {}, onExit: (callback: (event: { exitCode: number }) => void) => callback({ exitCode: 0 }) };
  },
}));
const { runPtyCommand } = await import(${JSON.stringify(pathToFileURL(PTY_RUN_PATH).href)});
test("clears inherited capability", async () => {
  await runPtyCommand({ command: "true", shell: "bash", cwd: process.cwd(), timeoutMs: 1_000 });
  expect(capability).toBe("");
});
`
  );
  try {
    const result = Bun.spawnSync(["bun", "test", probe], {
      cwd: process.cwd(),
      env: { ...process.env, [DEPOSIT_CAPABILITY_ENV]: "f".repeat(64) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakePty {
  constructor(readonly pid: number) {}
  onData(): void {}
  onExit(): void {}
  write(): void {}
  resize(): void {}
  kill(): void {}
}

test("a capability present in the Deck's own environment never reaches a PTY that was not given one", () => {
  const envs: Array<Record<string, string | undefined>> = [];
  const manager = new PtyManager({
    pty: {
      spawn: ((_file: string, _args: string[], options: { env: Record<string, string | undefined> }) => {
        envs.push(options.env);
        return new FakePty(envs.length) as unknown as IPty;
      }) as never,
    },
    setTimeout: (() => 0 as unknown as NodeJS.Timeout) as never,
    clearTimeout: () => {},
    reportError: () => {},
  });
  const previous = process.env[DEPOSIT_CAPABILITY_ENV];
  process.env[DEPOSIT_CAPABILITY_ENV] = "f".repeat(64);
  try {
    manager.spawn("tile-a", "C:/work", { command: "claude", shell: "bash", interactive: false }, {});
    manager.spawn("tile-b", "C:/work", { command: "claude", shell: "bash", interactive: false });
    const given = mintDepositCapability();
    manager.spawn("tile-c", "C:/work", { command: "claude", shell: "bash", interactive: false }, { [DEPOSIT_CAPABILITY_ENV]: given });
    expect(envs.map((e) => e[DEPOSIT_CAPABILITY_ENV])).toEqual(["", "", given]);
  } finally {
    if (previous === undefined) delete process.env[DEPOSIT_CAPABILITY_ENV];
    else process.env[DEPOSIT_CAPABILITY_ENV] = previous;
  }
});
