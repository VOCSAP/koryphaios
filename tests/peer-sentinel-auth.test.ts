// Pins isSentinelInstanceToken's truth table directly: broker.ts has zero
// exports and calls Bun.serve at module scope, so it cannot be imported, and
// this pure predicate is what every HTTP route and the WS handshake actually
// key their refusal off.

import { test, expect } from "bun:test";
import { isSentinelInstanceToken, SENTINEL_DEFINITIONS } from "../shared/types.ts";

test.each([
  ["__operator__", true],
  ["__deck__", true],
  ["__x__", true],
  ["__", false], // no content between the delimiters, /.+/ requires >=1 char
  ["_x_", false], // single underscore on each side, not the double-underscore shape
  ["operator", false],
  ["", false],
  ["__operator", false], // missing trailing delimiter
  ["operator__", false], // missing leading delimiter
  ["__oper__ator__", true], // shape only cares about the outer delimiters
])("isSentinelInstanceToken(%j) -> %p", (token, expected) => {
  expect(isSentinelInstanceToken(token)).toBe(expected);
});

test("every currently-defined sentinel instance_token is refused by the shape predicate", () => {
  // Reciprocity check (same spirit as findUnbackedInstanceTokenExports):
  // the predicate must actually cover every real sentinel, not just the
  // synthetic shapes above.
  for (const def of SENTINEL_DEFINITIONS) {
    expect(isSentinelInstanceToken(def.instanceToken)).toBe(true);
  }
});

test("an ordinary, non-sentinel-shaped instance_token is never refused by this predicate", () => {
  // Negative control: an unknown-but-not-sentinel-shaped token must fall
  // through this predicate untouched -- it is refused later, by the DB
  // lookup, not by isSentinelInstanceToken. Proves the predicate
  // discriminates rather than refusing everything.
  expect(isSentinelInstanceToken("some-real-peer-instance-token-abc123")).toBe(false);
});
