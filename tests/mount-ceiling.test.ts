import { expect, test } from "bun:test";
import {
  DECK_ROLE_ENV,
  OPERATOR_TOOLS,
  encodeMountCeiling,
  resolveMountCeiling,
  resolveMountRole,
} from "../shared/mount-ceiling.ts";

const REGISTRY = ["alpha", "beta", "gamma"] as const;

test("an absent or empty ceiling is refused with a reason that names the variable, never widened to the registry", () => {
  for (const raw of [undefined, ""]) {
    const resolved = resolveMountCeiling("KORY_TEST_TOOLS", raw, REGISTRY);
    expect(resolved.ok, `${JSON.stringify(raw)} was accepted`).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("KORY_TEST_TOOLS");
  }
});

test("a well-formed list resolves to exactly its names, in order", () => {
  expect(resolveMountCeiling("V", "gamma,alpha", REGISTRY)).toEqual({ ok: true, value: ["gamma", "alpha"] });
});

test("none is the explicit empty set", () => {
  expect(resolveMountCeiling("V", "none", REGISTRY)).toEqual({ ok: true, value: [] });
});

test("an unknown name, a duplicate, an empty entry or a space refuses the whole set instead of trimming it", () => {
  for (const raw of ["alpha,bogus", "alpha,alpha", "alpha,", ",alpha", "alpha, beta", "ALPHA", "none,alpha"]) {
    expect(resolveMountCeiling("V", raw, REGISTRY).ok, `${JSON.stringify(raw)} was accepted`).toBe(false);
  }
});

test("a hostile long entry is truncated in the reason", () => {
  const resolved = resolveMountCeiling("V", `alpha,${"x".repeat(500)}`, REGISTRY);
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) expect(resolved.reason.length).toBeLessThan(200);
});

test("encodeMountCeiling round-trips through the resolver, the empty set included", () => {
  for (const tools of [["alpha"], ["beta", "gamma"], [] as string[]]) {
    expect(resolveMountCeiling("V", encodeMountCeiling(tools), REGISTRY)).toEqual({ ok: true, value: tools });
  }
  expect(encodeMountCeiling(OPERATOR_TOOLS)).toBe(OPERATOR_TOOLS.join(","));
});

test("the role resolver accepts exactly supervisor and lead", () => {
  expect(resolveMountRole("supervisor")).toEqual({ ok: true, value: "supervisor" });
  expect(resolveMountRole("lead")).toEqual({ ok: true, value: "lead" });
  for (const raw of [undefined, "", "worker", "Lead", " lead"]) {
    const resolved = resolveMountRole(raw);
    expect(resolved.ok, `${JSON.stringify(raw)} was accepted as a role`).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain(DECK_ROLE_ENV);
  }
});
