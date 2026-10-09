// Measures, on the runner itself, the two times the TTSR regex budget must sit
// between. Both scale with the CPU, so each is compared to the budget on the
// same machine rather than to a fixed number of milliseconds.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TTSR_REGEX_BUDGET_MS, fieldCap } from "../desktop/src/shared/ttsr-rules";
import { KORY_RULES } from "../desktop/src/shared/ttsr-builtin";
import { probeInputs } from "../desktop/src/shared/ttsr-probe";

function timeOnce(re: RegExp, s: string): { ms: number; hit: boolean } {
  const t0 = performance.now();
  const hit = re.test(s);
  return { ms: performance.now() - t0, hit };
}

const CATASTROPHIC: [string, (n: number) => string][] = [
  ["x(?:ab|a|b)*$|DANGER", (n) => `echo x${"ab".repeat(n)}! DANGER`.replace("DANGER", "D")],
  ["(a+)+$", (n) => `${"a".repeat(n)}!`],
  ["(a|a)*c", (n) => "a".repeat(n)],
  ["(x+x+)+y", (n) => "x".repeat(n)],
  ["^(a+)+$", (n) => `${"a".repeat(n)}!`],
];

test("the fastest JavaScriptCore match-limit cut stays at least 3x the regex budget", () => {
  let fastest = Infinity;
  for (const [pattern, make] of CATASTROPHIC) {
    const re = new RegExp(pattern);
    for (const n of [40, 4096]) {
      const { ms, hit } = timeOnce(re, make(n));
      expect(hit, `${pattern} at n=${n} must find no match, or the time measured is a match, not a cut`).toBe(false);
      fastest = Math.min(fastest, ms);
    }
  }
  expect(
    fastest,
    `a catastrophic deny pattern is only caught if its cut outlasts the budget: fastest cut ${fastest.toFixed(1)} ms vs budget ${TTSR_REGEX_BUDGET_MS} ms`
  ).toBeGreaterThanOrEqual(3 * TTSR_REGEX_BUDGET_MS);
}, 60_000);

test("the worst legitimate Kory rule time stays at most half the regex budget", () => {
  const corpus = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf-8");
  let worst = 0;
  let worstAt = "";
  for (const rule of KORY_RULES) {
    const re = new RegExp(rule.pattern, rule.flags ?? "");
    const cap = fieldCap(rule.field);
    for (const s of [corpus.slice(0, cap), ...probeInputs(rule.pattern, cap, rule.flags ?? "")]) {
      let best = Infinity;
      for (let i = 0; i < 3; i++) best = Math.min(best, timeOnce(re, s).ms);
      if (best > worst) {
        worst = best;
        worstAt = rule.id;
      }
    }
  }
  expect(
    worst,
    `a legitimate rule must never be denied by the budget: worst ${worst.toFixed(2)} ms (${worstAt}) vs budget ${TTSR_REGEX_BUDGET_MS} ms`
  ).toBeLessThanOrEqual(TTSR_REGEX_BUDGET_MS / 2);
}, 60_000);
