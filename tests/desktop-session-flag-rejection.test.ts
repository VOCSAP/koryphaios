// SessionService cannot be instantiated under bun test (electron + node-pty), so
// the real flagValue() body and the real agent/model statements of create() are
// read from the source text and RUN against a recording reportError.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractBracedBody } from "./_braced-body";
import { buildSessionCommandLine, sanitizeFlagValue } from "../desktop/src/main/session-command";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");
const SRC = readFileSync(SESSION_SERVICE_PATH, "utf-8");

type Trace = { scope: string; message: string };

function sliceOnce(head: string): number {
  const start = SRC.indexOf(head);
  if (start === -1 || SRC.indexOf(head, start + 1) !== -1) {
    throw new Error(`session-service.ts: expected exactly 1 "${head}"`);
  }
  return start;
}

function makeFlagValue(): { flagValue: (field: string, raw: string | undefined) => string; traces: Trace[] } {
  const head = "private flagValue(field: string, raw: string | undefined): string {";
  const body = extractBracedBody(SRC, sliceOnce(head) + head.length - 1);
  const traces: Trace[] = [];
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("field", "raw", "sanitizeFlagValue", "reportError", body);
  return {
    traces,
    flagValue: (field, raw) =>
      fn(field, raw, sanitizeFlagValue, (scope: string, message: string) => traces.push({ scope, message })) as string
  };
}

function runCreateAgentModelArgs(input: { agent?: string; model?: string; args?: string }): {
  args: string;
  traces: Trace[];
} {
  const head = "const agent = this.flagValue('agent', input.agent)";
  const start = sliceOnce(head);
  const tail = ".join(' ')";
  const end = SRC.indexOf(tail, start);
  if (end === -1 || end - start > 400) throw new Error(`"${tail}" does not close the args block after "${head}"`);
  const { flagValue, traces } = makeFlagValue();
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("input", `${SRC.slice(start, end + tail.length)}\nreturn args`);
  return { args: fn.call({ flagValue }, input) as string, traces };
}

test("a rejected non-empty model is omitted from the create() args AND traced with its field and value", () => {
  const { args, traces } = runCreateAgentModelArgs({ agent: "developer", model: "x$(cmd)" });
  expect(args).toBe('--agent "developer"');
  expect(traces.length).toBe(1);
  expect(traces[0]!.scope).toBe("session");
  expect(traces[0]!.message).toContain("model");
  expect(traces[0]!.message).toContain("x$(cmd)");
});

test("a rejected non-empty agent is omitted from the create() args AND traced with its field", () => {
  const { args, traces } = runCreateAgentModelArgs({ agent: "dev;rm", model: "opus" });
  expect(args).toBe('--model "opus"');
  expect(traces.length).toBe(1);
  expect(traces[0]!.message).toMatch(/^agent /);
  expect(traces[0]!.message).toContain("dev;rm");
});

test("absent, empty and whitespace-only values leave no trace on the normal path", () => {
  for (const input of [{}, { agent: "", model: "" }, { agent: "   ", model: "\t" }]) {
    const { args, traces } = runCreateAgentModelArgs(input);
    expect(args).toBe("");
    expect(traces).toEqual([]);
  }
});

test("valid identifiers, including the [1m] model suffix, pass through untraced", () => {
  const { args, traces } = runCreateAgentModelArgs({ agent: "team-lead", model: "claude-opus-4-6[1m]" });
  expect(args).toBe('--agent "team-lead" --model "claude-opus-4-6[1m]"');
  expect(traces).toEqual([]);
});

test("the traced value is truncated and escaped, so a hostile value cannot flood or split the log line", () => {
  const { flagValue, traces } = makeFlagValue();
  const hostile = `${"a".repeat(60)}\n$(x)${"b".repeat(200)}`;
  expect(flagValue("effort", hostile)).toBe("");
  expect(traces.length).toBe(1);
  expect(traces[0]!.message).not.toContain("\n");
  expect(traces[0]!.message).toContain(JSON.stringify(hostile.slice(0, 64)));
  expect(traces[0]!.message).not.toContain("b".repeat(10));
});

test("the trace names the real consequence: flag omitted for agent/model/effort, bridge decision only for the effective agent", () => {
  const { flagValue, traces } = makeFlagValue();
  for (const field of ["agent", "model", "effort", "effective agent"]) flagValue(field, "x$(cmd)");
  expect(traces.map((t) => t.message.split(":")[0])).toEqual([
    "agent value refused by the flag allow-list, flag omitted",
    "model value refused by the flag allow-list, flag omitted",
    "effort value refused by the flag allow-list, flag omitted",
    "effective agent value refused by the flag allow-list, ignored for the bridge decision"
  ]);
});

test("create() persists no rejected effort: the def literal's effort is empty and traced once", () => {
  const createMatches = [...SRC.matchAll(/\n {2}create\(\r?\n {4}input: CreateSessionInput,/g)];
  if (createMatches.length !== 1) throw new Error(`session-service.ts: expected exactly 1 create( declaration, got ${createMatches.length}`);
  const createStart = createMatches[0]!.index!;
  const defHead = "const def: SessionDef = {";
  const defStart = SRC.indexOf(defHead, createStart);
  if (defStart === -1) throw new Error(`"${defHead}" not found in create()`);
  const literal = extractBracedBody(SRC, defStart + defHead.length - 1);
  const effortLines = literal.split("\n").filter((line) => /^\s*effort:/.test(line));
  expect(effortLines.length).toBe(1);
  const { flagValue, traces } = makeFlagValue();
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("input", `return { ${effortLines[0]!.trim().replace(/,$/, "")} }`);
  const def = fn.call({ flagValue }, { effort: "high; rm -rf ~" }) as { effort: string };
  expect(def.effort).toBe("");
  expect(traces.length).toBe(1);
  expect(traces[0]!.message).toMatch(/^effort /);
});

test("a rejected effort is traced, and buildSessionCommandLine omits --effort for the value flagValue hands it", () => {
  const { flagValue, traces } = makeFlagValue();
  const command = buildSessionCommandLine({
    baseCommand: "claude",
    sessionId: "00000000-0000-0000-0000-000000000000",
    effort: flagValue("effort", "high; rm -rf ~"),
    mode: "fresh"
  });
  expect(command).not.toContain("--effort");
  expect(traces.length).toBe(1);
  expect(traces[0]!.message).toMatch(/^effort /);
});

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*/, ""))
    .join("\n");
}

test("every sanitizeFlagValue call in session-service goes through flagValue", () => {
  const code = codeOnly(SRC);
  expect((code.match(/sanitizeFlagValue\(/g) ?? []).length).toBe(1);
  expect(code).toContain("this.flagValue('effective agent', launched.agent)");
});

test("each buildSessionCommandLine call of startPty routes its effort through flagValue", () => {
  const head = "private startPty(def: SessionDef, mode: SpawnMode): void {";
  const body = extractBracedBody(SRC, sliceOnce(head) + head.length - 1);
  const callHead = "buildSessionCommandLine({";
  const literals: string[] = [];
  for (let i = body.indexOf(callHead); i !== -1; i = body.indexOf(callHead, i + 1)) {
    literals.push(codeOnly(extractBracedBody(body, i + callHead.length - 1)));
  }
  expect(literals.length).toBe(2);
  for (const literal of literals) {
    const efforts = literal.split("\n").filter((line) => /^\s*effort:/.test(line));
    expect(efforts.map((line) => line.trim())).toEqual(["effort: this.flagValue('effort', def.effort),"]);
  }
});
