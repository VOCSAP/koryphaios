import { expect, test } from "bun:test";
import {
  assertClodexContextInput,
  clodexContextEnv,
  CLODEX_CONTEXT_ENV,
  effectiveClodexContextTokens,
  isClodexContextTokens,
  isValidClodexContextInput,
} from "../desktop/src/shared/clodex-context.ts";

test("the bounds are inclusive and only integers inside them are accepted", () => {
  expect(isClodexContextTokens(200_000)).toBe(true);
  expect(isClodexContextTokens(872_000)).toBe(true);
  expect(isClodexContextTokens(199_999)).toBe(false);
  expect(isClodexContextTokens(872_001)).toBe(false);
  expect(isClodexContextTokens(300_000.5)).toBe(false);
  for (const bad of [Number.NaN, Infinity, -Infinity, "300000", null, undefined, true, {}, []]) {
    expect(isClodexContextTokens(bad), String(typeof bad)).toBe(false);
  }
});

test("an input is valid when absent or in range; null and strings are refused, not coerced", () => {
  expect(isValidClodexContextInput(undefined)).toBe(true);
  expect(isValidClodexContextInput(300_000)).toBe(true);
  expect(isValidClodexContextInput(null)).toBe(false);
  expect(isValidClodexContextInput("300000")).toBe(false);
  expect(() => assertClodexContextInput(1)).toThrow("between 200000 and 872000");
  expect(() => assertClodexContextInput(undefined)).not.toThrow();
});

test("absent or invalid stored values resolve to 200000", () => {
  expect(effectiveClodexContextTokens(undefined)).toBe(200_000);
  expect(effectiveClodexContextTokens("999999")).toBe(200_000);
  expect(effectiveClodexContextTokens(531_000)).toBe(531_000);
});

test("only a tile that launches through the clodex wrapper gets the variable, as a decimal string", () => {
  expect(clodexContextEnv({ bridge: "clodex", clodexContextTokens: 872_000 }, true)).toEqual({ [CLODEX_CONTEXT_ENV]: "872000" });
  expect(clodexContextEnv({ bridge: "clodex" }, true)).toEqual({ [CLODEX_CONTEXT_ENV]: "200000" });
  expect(clodexContextEnv({ bridge: "clodex", clodexContextTokens: 300_000 }, false)).toEqual({});
  expect(clodexContextEnv({ clodexContextTokens: 300_000 }, true)).toEqual({});
  expect(clodexContextEnv({ bridge: "other", clodexContextTokens: 300_000 }, true)).toEqual({});
});
