// Card 78bf378d: the WS handshake in broker.ts now calls
// refuseSentinelInstanceToken (broker.ts, HTTP-side helper) before its DB
// lookup -- but broker.ts has zero exports and calls Bun.serve at module
// scope (card e7b364dc's own precedent note, repeated in the DISCIPLINE
// section of this card's brief), so it cannot be imported by a test. What
// IS importable, and IS the actual refusal predicate both the 9 HTTP routes
// and the new WS call site key off, is isSentinelInstanceToken -- a pure
// function in shared/types.ts (card 37a2b8c7). This file pins its truth
// table directly, no broker/WS harness needed, mirroring
// tests/roadmap-lock.test.ts for shared/roadmap-lock.ts.
//
// Named tests/peer-*.test.ts (not tests/broker-*): the CI workflow
// (.github/workflows/desktop-build.yml) collects `tests/peer-*.test.ts` but
// excludes the whole `broker-*` family (see tests/desktop-ci-glob-coverage.test.ts).
// This file imports only shared/types.ts, no startBroker, no live broker or
// WS socket -- a broker-*-prefixed end-to-end test that opens a real WS and
// exercises the sentinel-refusal close path is a separate, optional
// follow-up per this card's brief, acceptable only because this pure truth
// table exists first.

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
