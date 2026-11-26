import { describe, expect, test } from "bun:test";
import { envInt, type EnvIntRule } from "../shared/env-int.ts";

const NAME = "CLAUDE_PEERS_PROBE_MS";

interface Reading {
  value: number;
  warnings: Array<[string, { value: string }]>;
}

function read(raw: string | undefined, belowMin: EnvIntRule["belowMin"] = "min"): Reading {
  const warnings: Reading["warnings"] = [];
  const value = envInt(NAME, raw, { min: 200, max: 1000, fallback: 500, belowMin }, (message, context) =>
    warnings.push([message, context])
  );
  return { value, warnings };
}

const warned = (raw: string, used: number): Reading => ({
  value: used,
  warnings: [[`${NAME} is not an integer between 200 and 1000, using ${used}`, { value: raw }]],
});

describe("envInt", () => {
  test("an unset variable is the fallback, without a warning", () => {
    expect(read(undefined)).toEqual({ value: 500, warnings: [] });
  });

  test.each(["200", "201", "999", "1000"])("%p is inside the bounds and used as written", (raw) => {
    expect(read(raw)).toEqual({ value: Number(raw), warnings: [] });
  });

  test.each(["199", "100", "0", "-5"])("%p under the floor becomes the floor under the 'min' rule, and says so", (raw) => {
    expect(read(raw, "min")).toEqual(warned(raw, 200));
  });

  test.each(["199", "0", "-5"])("%p under the floor becomes the default under the 'fallback' rule, and says so", (raw) => {
    expect(read(raw, "fallback")).toEqual(warned(raw, 500));
  });

  test.each(["1001", "2147483648", "99999999999"])("%p above the ceiling becomes the default under both rules", (raw) => {
    expect([read(raw, "min"), read(raw, "fallback")]).toEqual([warned(raw, 500), warned(raw, 500)]);
  });

  test.each(["abc", "NaN", "Infinity", "-Infinity", "300abc", "300.5", "1.5", "-1.5", "", "  ", "-9007199254740993"])(
    "%p is not a safe integer and becomes the default even under the 'min' rule",
    (raw) => {
      expect(read(raw, "min")).toEqual(warned(raw, 500));
    }
  );
});
