// Roadmap card 39c40571, LAYER 1: COVERAGE of the author guard, not just its
// sensitivity.
//
// A test that fires the known defect at the known handler passes honestly and
// proves nothing about the rest of the domain. This repo has measured that
// failure four times (a discipline test announcing "every handler" while its
// hardcoded list covered 4 of 8). So this file does not carry a list of routes:
// it DISCOVERS them from broker.ts and forces every newly discovered one to be
// classified before it can be considered covered.
//
// Two negative controls keep the extractor itself from becoming the silent
// point of failure:
//   1. the discovered set is compared to an explicit expected set, so a
//      reformat that shrinks the extraction is RED ("extraction shrank"),
//      never a quietly smaller subset;
//   2. the extractor is run against a FIXTURE containing a route that exists
//      nowhere in production, proving it actually bites. The sentinel lives in
//      the fixture on purpose -- an unguarded sentinel route left in the real
//      routing table would be a hole in itself.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import type { RegisterResponse, RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/route-coverage-repo";
const BROKER_SRC = join(import.meta.dir, "..", "broker.ts");

/**
 * Every "/roadmap/..." route literal the broker source mentions.
 *
 * The tail is "everything up to the closing quote", NOT `[a-z-]+`: a shape the
 * regex cannot express is invisible to every assertion below at once, since all
 * three consume this one extraction. `[a-z-]+` covered only FLAT routes, so a
 * nested `/roadmap/lot/reorder` (already proposed in WORKFLOW-LOTS-DESIGN.md)
 * would have been silently undiscovered -- the file would have caught the
 * domain SHRINKING while missing it GROWING out of shape. Over-matching is the
 * safe direction here: an odd capture lands in neither classification set and
 * fails the test CLOSED.
 */
function discoverRoadmapRoutes(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/["'`](\/roadmap\/[^"'`\s]+)["'`]/g)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Classification. Anything discovered and NOT listed here is, by construction,
// unclassified -- and the test below fails until someone decides which it is.
// The default for a new route is therefore "must be guarded", i.e. fail CLOSED.
// ---------------------------------------------------------------------------

/** Read-only: no author to prove. */
const READ_ROUTES = new Set(["/roadmap/list", "/roadmap/export"]);

/**
 * Nothing left to exempt: card 40ddf1f5 wired resolveRoadmapAuthor into
 * /roadmap/import (it used to be exempted here on the grounds that its guard
 * was that card's job, not this file's -- the exemption's own reasoning said
 * so). An empty set is kept, not deleted, so the fail-closed default below
 * (unclassifiedRoutes) still has three buckets to check a future route
 * against, not two.
 */
const EXEMPT_ROUTES = new Set<string>([]);

/** Write routes that must refuse an unproven author, with a well-formed body. */
const GUARDED_PROBES: Record<string, (ctx: ProbeCtx) => Record<string, unknown>> = {
  "/roadmap/upsert": (c) => ({ project_key: PK, id: c.itemId, by: c.victimPeerId, description: "x" }),
  "/roadmap/archive": (c) => ({ id: c.itemId, by: c.victimPeerId }),
  "/roadmap/reorder": (c) => ({ project_key: PK, by: c.victimPeerId, ids: [c.itemId] }),
  // items: [] on purpose (well-formed empty array, not omitted): the route
  // checks project_key and items-is-an-array BEFORE resolveRoadmapAuthor, so
  // an omitted/malformed items field would 400 for the wrong reason and pass
  // this probe without ever exercising the identity guard.
  "/roadmap/import": (c) => ({ project_key: PK, by: c.victimPeerId, items: [] }),
  // Card 562fd9b5: goes through resolveRoadmapAuthor exactly like the four
  // above (same function, same order -- checked before id/text validation),
  // so it belongs HERE, not in EXEMPT_ROUTES. Its only difference from
  // upsert/archive/reorder/import is a SEPARATE, unrelated exemption from
  // the work-lock guard (this file tests the AUTHOR guard, card 39c40571 --
  // not every guard in the system; the lock exemption is card 562fd9b5's own
  // decision, documented at handleRoadmapContextAppend in broker.ts). Filing
  // it as EXEMPT here would silently stop testing that its author check
  // actually refuses impersonation.
  "/roadmap/append-context": (c) => ({ id: c.itemId, by: c.victimPeerId, text: "x" }),
};

interface ProbeCtx {
  itemId: string;
  victimPeerId: string;
}

/**
 * The classification rule itself, as a pure function, so the fixture probe
 * below exercises the SAME code path as the production assertion. Inlining it
 * in the test would leave the probe testing a copy.
 */
function unclassifiedRoutes(routes: string[]): string[] {
  return routes.filter(
    (r) => !READ_ROUTES.has(r) && !EXEMPT_ROUTES.has(r) && !(r in GUARDED_PROBES)
  );
}

// The expected set. Kept explicit ON PURPOSE: it is the only thing that can
// tell "the source has no other roadmap route" apart from "my regex stopped
// matching". Update it deliberately when a route is added or removed.
const EXPECTED_ROUTES = [
  "/roadmap/append-context",
  "/roadmap/archive",
  "/roadmap/export",
  "/roadmap/import",
  "/roadmap/list",
  "/roadmap/reorder",
  "/roadmap/upsert",
];

test("the extractor bites: it finds a route that exists only in a fixture", () => {
  const fixture = `
    switch (path) {
      case "/roadmap/list": return listIt();
      case "/roadmap/fixture-only-route": return neverInProduction();
    }
  `;
  const found = discoverRoadmapRoutes(fixture);
  expect(found).toContain("/roadmap/fixture-only-route");
  expect(found).toContain("/roadmap/list");
});

test("the extractor bites on a NESTED route, and that route is reported unclassified", () => {
  // WORKFLOW-LOTS-DESIGN.md proposes /roadmap/lot/reorder. Under the previous
  // `[a-z-]+` tail this fixture yielded ONLY /roadmap/list: the nested route was
  // neither discovered nor unclassified nor red. Both halves are asserted here,
  // because discovery alone would not prove the route reaches the guard rule --
  // and the rule is the shared `unclassifiedRoutes`, not a copy of it.
  const fixture = `
    switch (path) {
      case "/roadmap/list": return listIt();
      case "/roadmap/lot/reorder": return reorderALot();
    }
  `;
  const found = discoverRoadmapRoutes(fixture);
  expect(found).toContain("/roadmap/lot/reorder");
  expect(unclassifiedRoutes(found)).toEqual(["/roadmap/lot/reorder"]);
});

test("extraction has not shrunk: broker.ts exposes exactly the expected routes", () => {
  const routes = discoverRoadmapRoutes(readFileSync(BROKER_SRC, "utf8"));
  // Equality, not superset: a route that DISAPPEARS from the extraction is as
  // dangerous as one that appears unclassified, because the guard would then
  // silently cover less than this file claims.
  expect(routes).toEqual(EXPECTED_ROUTES);
});

test("every discovered route is classified: read, consciously exempt, or guarded", () => {
  const routes = discoverRoadmapRoutes(readFileSync(BROKER_SRC, "utf8"));
  expect(unclassifiedRoutes(routes)).toEqual([]);
});

test("every guarded write route refuses an author it cannot prove", async () => {
  const victim = await post<RegisterResponse>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: "/work/coverage-victim",
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  expect(victim.status).toBe(200);

  const seeded = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "unregistered-fixture",
    title: "coverage target",
  });
  expect(seeded.status).toBe(200);

  const ctx: ProbeCtx = { itemId: seeded.body.item.id, victimPeerId: victim.body.peer_id };

  for (const [route, makeBody] of Object.entries(GUARDED_PROBES)) {
    const res = await post<{ error?: string }>(`${broker.url}${route}`, makeBody(ctx));
    // 401 exactly, not "some 4xx": the body is well-formed on purpose, so the
    // only legitimate refusal is the identity one. Accepting any 4xx would keep
    // passing if a route started answering 400 (missing field) or 404 (unknown
    // item) -- refusing for the wrong reason, with the guard bypassed. Assert
    // through a tuple carrying the route so a failure names WHICH one drifted.
    expect([route, res.status]).toEqual([route, 401]);
  }
});
