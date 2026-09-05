// Routes are discovered from the router's own source rather than hardcoded,
// since a hardcoded list has repeatedly covered only a fraction of the handlers
// while claiming full coverage.
// Two negative controls guard the extractor itself: the discovered set is
// diffed against an explicit expected set, so a shrinking extraction fails
// loudly instead of quietly returning a smaller subset.
// The extractor is also run against a fixture route that exists nowhere in
// production, to prove it actually fires.

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
const READ_ROUTES = new Set([
  "/roadmap/list",
  "/roadmap/export",
  "/roadmap/sync/pull",
  "/roadmap/sync/status",
  "/roadmap/sync/conflicts",
]);

/**
 * The two replication WRITE routes. They are exempt from the author guard by
 * construction, not by oversight: their caller is a replica BROKER, and what
 * they write is a state another broker already resolved and attributed, for
 * agents that have no `peers` row here to prove anything with. What stands in
 * for resolveRoadmapAuthor on these two is a chain of three guarantees, each
 * asserted where the routes themselves are tested:
 *
 * 1. the shared broker_token is REQUIRED -- a broker configured without one
 *    does not serve them at all (probed live below, since this file's broker
 *    is exactly such a deployment);
 * 2. the work-lock still binds -- a push onto a card locked by a holder this
 *    replica does not relay is refused 409 'locked_upstream', the same answer
 *    a third party gets from /roadmap/upsert;
 * 3. the transported `created_by`/`updated_by` go through
 *    normalizeAuthorIdentity, are REFUSED when they claim another replica's
 *    `via:` prefix, and are rewritten to `via:<replica8>:<name>` whenever they
 *    name a reserved identity, a peer registered here, or the stale-lock
 *    sweep. So the provenance a replica asserts is its own or none: a relayed
 *    write can never be read as this broker's operator, one of its agents, its
 *    sweep, or another machine's relay. What it does NOT promise, and cannot:
 *    the peer check happens at push time, so a plain name kept verbatim today
 *    reads as a peer of that name if one registers here tomorrow.
 *
 * `/roadmap/sync/resolve` is the opposite case and sits in GUARDED_PROBES: it
 * is the OPERATOR arbitrating, i.e. an ordinary Deck write.
 */
const EXEMPT_ROUTES = new Set<string>(["/roadmap/sync/push", "/roadmap/sync/lock"]);

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
  // The author is resolved before the replica-only check, so this probe reaches
  // the identity guard on any broker, replica or not.
  "/roadmap/sync/resolve": (c) => ({ id: c.itemId, by: c.victimPeerId, choice: "local" }),
};

/**
 * Card aaf4537d (team-lead arbitration): routes that DO resolve a provable
 * identity (resolveRoadmapAuthor succeeds for an ordinary, unreserved `by`)
 * but still refuse the write because operator PRIVILEGE, not identity, is
 * missing -- 403, not 401. A route that belongs here can never sit in
 * GUARDED_PROBES: that dict's own test asserts exactly 401, so folding a
 * 403-shaped route in there would either force a wrong status through the
 * shared assertion or silently stop testing the 401 case for everyone else.
 * A new operator-gated route must be added HERE explicitly (or to
 * GUARDED_PROBES, or to READ_ROUTES/EXEMPT_ROUTES) -- unclassifiedRoutes
 * below still fails closed on anything left out of all four.
 */
const OPERATOR_GUARDED_PROBES: Record<string, (ctx: ProbeCtx) => Record<string, unknown>> = {
  "/roadmap/lock-park": (c) => ({ project_key: PK, by: c.victimPeerId, peer_ids: [c.victimPeerId] }),
  "/roadmap/lock-release": (c) => ({ project_key: PK, by: c.victimPeerId, peer_ids: [c.victimPeerId] }),
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
    (r) =>
      !READ_ROUTES.has(r) &&
      !EXEMPT_ROUTES.has(r) &&
      !(r in GUARDED_PROBES) &&
      !(r in OPERATOR_GUARDED_PROBES)
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
  "/roadmap/lock-park",
  "/roadmap/lock-release",
  "/roadmap/reorder",
  "/roadmap/sync/conflicts",
  "/roadmap/sync/lock",
  "/roadmap/sync/pull",
  "/roadmap/sync/push",
  "/roadmap/sync/resolve",
  "/roadmap/sync/status",
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

test("the author-exempt replication routes are not open: with no broker_token they are not served", async () => {
  // The mechanical half of the exemption above. This file's broker runs with no
  // CLAUDE_PEERS_BROKER_TOKEN, so both routes must refuse outright -- a body
  // that would otherwise be accepted (the push inserts, the claim is well
  // formed) and no author to prove anywhere in it.
  const probes: Record<string, Record<string, unknown>> = {
    "/roadmap/sync/push": {
      replica_id: "replica-coverage",
      expected_content_rev: null,
      item: {
        id: "card-coverage-exempt",
        project_key: PK,
        kind: "feature",
        title: "pushed with no credential at all",
        description: "",
        rationale: "",
        context: "",
        priority: "could",
        value: "medium",
        effort: "medium",
        status: "planned",
        tags: [],
        depends_on: [],
        deleted_at: null,
        directive: null,
        target_peer_ids: [],
        inactive: false,
        created_by: "deck",
        updated_by: "deck",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    },
    "/roadmap/sync/lock": {
      replica_id: "replica-coverage",
      id: "card-coverage-exempt",
      action: "claim",
      owner: { peer_id: "agent-coverage", group_id: "default" },
    },
  };
  // Every exempt route is probed, so a third one added to the set without a
  // probe fails here rather than joining the exemption unexamined.
  expect(Object.keys(probes).sort()).toEqual([...EXEMPT_ROUTES].sort());
  for (const [route, body] of Object.entries(probes)) {
    const res = await post<{ error?: string }>(`${broker.url}${route}`, body);
    expect([route, res.status]).toEqual([route, 403]);
    expect([route, (res.body.error ?? "").includes("broker_token")]).toEqual([route, true]);
  }
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

// The 401 loop above can't by itself catch a route misclassified into
// GUARDED_PROBES that actually belongs in OPERATOR_GUARDED_PROBES, since
// resolveRoadmapAuthor's impersonation gate 401s first for any registered `by`,
// regardless of bucket.
// This second probe uses an unregistered `by` and asserts the response is never
// 403: only OPERATOR_GUARDED_PROBES routes check author.operator_id ===
// undefined, so a misclassified route would go red here specifically.
test("no guarded write route silently requires operator proof (that gate belongs to OPERATOR_GUARDED_PROBES only)", async () => {
  const seeded = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "unregistered-fixture-2",
    title: "coverage target (unregistered-author probe)",
  });
  expect(seeded.status).toBe(200);

  const ctx: ProbeCtx = {
    itemId: seeded.body.item.id,
    victimPeerId: "unregistered-guarded-probe-fixture",
  };

  for (const [route, makeBody] of Object.entries(GUARDED_PROBES)) {
    const res = await post<{ error?: string }>(`${broker.url}${route}`, makeBody(ctx));
    expect([route, res.status]).not.toEqual([route, 403]);
  }
});

test("every operator-guarded write route refuses a well-formed write with no operator proof, with 403 (identity is provable, privilege is not)", async () => {
  // `by` is deliberately unregistered here: a registered peer_id would trip
  // resolveRoadmapAuthor's own identity-proof branch first (401), masking this
  // route's separate operator-privilege gate (403).
  const seeded = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "unregistered-fixture-operator",
    title: "operator coverage target",
  });
  expect(seeded.status).toBe(200);

  const ctx: ProbeCtx = { itemId: seeded.body.item.id, victimPeerId: "unregistered-fixture-operator" };

  for (const [route, makeBody] of Object.entries(OPERATOR_GUARDED_PROBES)) {
    const res = await post<{ error?: string }>(`${broker.url}${route}`, makeBody(ctx));
    expect([route, res.status]).toEqual([route, 403]);
  }
});

// A second axis, keyed on handler function names rather than routes: proves
// resolveRoadmapAuthor is called everywhere, but says nothing about whether a
// handler that touches status/locked also carries the inactive-claim guard.
// Known limitation: only classifies handlers named
// handleRoadmap*/releaseStaleLocks, and only checks that a guarded handler's
// body contains a call to the two guard predicates -- it does not prove every
// code path reaches them.

/**
 * Handler function names discovered from broker.ts. Column-0-closing-brace
 * convention (see extractFunctionBody below) means these are always
 * top-level `function` declarations, never nested helpers.
 */
function discoverRoadmapHandlers(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/^function (handleRoadmap\w+|releaseStaleLocks)\(/gm)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

/**
 * A handler's return type is routinely a union with an inline object whose own
 * `{` is not followed by a newline, unlike the real body-opening brace --
 * matching the first `{...\n` (not just the first `{`) is what tells them
 * apart.
 */
function extractFunctionBody(source: string, name: string): string {
  const match = source.match(
    new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\)[\\s\\S]*?\\{\\r?\\n([\\s\\S]*?)\\r?\\n\\}`)
  );
  if (!match) throw new Error(`function ${name} not found in source`);
  return match[1]!;
}

/** Handlers that must refuse a claim on an inactive card. */
const GUARDED_INACTIVE_HANDLERS = new Set([
  "handleRoadmapUpsert",
  "handleRoadmapImport",
  // Relaying a claim for a remote agent is still a claim: the card ends up
  // locked, so the same predicate decides it.
  "handleRoadmapSyncLock",
]);

/**
 * Replication WRITE handlers that carry content between brokers without ever
 * claiming a card. They cannot take the inactive guard: what they write was
 * already arbitrated on the other broker (whose own guards ran), and refusing
 * it here would leave that card permanently unable to converge -- a silent
 * divergence instead of a refusal anyone sees. What makes the exemption safe
 * is that they never LOCK, checked mechanically below and behaviourally in
 * tests/broker-roadmap-sync-routes.test.ts.
 */
const REPLICATION_INACTIVE_HANDLERS = new Set([
  "handleRoadmapSyncPush",
  "handleRoadmapSyncResolve",
]);

/**
 * Handlers that structurally cannot claim a card (verified by reading each
 * one, not asserted on faith) -- each carries a one-line "why" comment in
 * broker.ts citing this card, checked below.
 */
const EXEMPT_INACTIVE_HANDLERS = new Set([
  "handleRoadmapArchive",
  "handleRoadmapContextAppend",
  "handleRoadmapLockPark",
  "handleRoadmapLockRelease",
  "handleRoadmapReorder",
  "releaseStaleLocks",
]);

/**
 * `discoverRoadmapHandlers`'s regex is deliberately over-inclusive (same
 * philosophy as discoverRoadmapRoutes above), so it also finds the two
 * read-only handlers -- neither cited in the write-path table this card was
 * scoped against. Classified here as a THIRD bucket, checked MECHANICALLY
 * (no `UPDATE roadmap_items`/`INSERT INTO roadmap_items` anywhere in the
 * body) rather than by a comment, since that is a strictly stronger
 * guarantee than a comment for a handler that does no write at all.
 */
const READ_ONLY_INACTIVE_HANDLERS = new Set([
  "handleRoadmapList",
  "handleRoadmapExport",
  "handleRoadmapSyncPull",
  "handleRoadmapSyncStatus",
  "handleRoadmapSyncConflicts",
]);

function unclassifiedInactiveHandlers(handlers: string[]): string[] {
  return handlers.filter(
    (h) =>
      !GUARDED_INACTIVE_HANDLERS.has(h) &&
      !EXEMPT_INACTIVE_HANDLERS.has(h) &&
      !READ_ONLY_INACTIVE_HANDLERS.has(h) &&
      !REPLICATION_INACTIVE_HANDLERS.has(h)
  );
}

const EXPECTED_INACTIVE_HANDLERS = [
  "handleRoadmapArchive",
  "handleRoadmapContextAppend",
  "handleRoadmapExport",
  "handleRoadmapImport",
  "handleRoadmapList",
  "handleRoadmapLockPark",
  "handleRoadmapLockRelease",
  "handleRoadmapReorder",
  "handleRoadmapSyncConflicts",
  "handleRoadmapSyncLock",
  "handleRoadmapSyncPull",
  "handleRoadmapSyncPush",
  "handleRoadmapSyncResolve",
  "handleRoadmapSyncStatus",
  "handleRoadmapUpsert",
  "releaseStaleLocks",
];

test("the handler extractor bites: it finds a handler that exists only in a fixture", () => {
  const fixture =
    "function handleRoadmapList(body) { return []; }\n" +
    "function handleRoadmapFixtureOnly(body) { return null; }\n";
  const found = discoverRoadmapHandlers(fixture);
  expect(found).toContain("handleRoadmapFixtureOnly");
});

test("a fixture-only handler is reported unclassified", () => {
  const fixture = `function handleRoadmapFixtureOnly(body) { return null; }`;
  const found = discoverRoadmapHandlers(fixture);
  expect(unclassifiedInactiveHandlers(found)).toEqual(["handleRoadmapFixtureOnly"]);
});

test("handler extraction has not shrunk: broker.ts exposes exactly the expected handlers", () => {
  const handlers = discoverRoadmapHandlers(readFileSync(BROKER_SRC, "utf8"));
  expect(handlers).toEqual(EXPECTED_INACTIVE_HANDLERS);
});

test("every discovered handler is classified: guarded or consciously exempt", () => {
  const handlers = discoverRoadmapHandlers(readFileSync(BROKER_SRC, "utf8"));
  expect(unclassifiedInactiveHandlers(handlers)).toEqual([]);
});

/**
 * Pins the exact call count per branch rather than a substring check: removing
 * the guard call from only one of handleRoadmapUpsert's two branches (patch,
 * create) left a substring check still true.
 */
const EXPECTED_INACTIVE_GUARD_CALL_COUNTS: Record<string, { claim: number; toggle: number }> = {
  handleRoadmapUpsert: { claim: 2, toggle: 2 }, // patch branch + create branch
  handleRoadmapImport: { claim: 1, toggle: 1 }, // one per-row call site
  // The relayed claim, once. This handler cannot toggle `inactive` at all --
  // it writes lock columns only -- so it has no toggle call site to expect.
  handleRoadmapSyncLock: { claim: 1, toggle: 0 },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Strips comments before counting calls: a removed real guard call refunded
 * with only a comment mentioning the function name left the substring count
 * unchanged, so the count must exclude comments to mean "this many calls", not
 * "this many mentions".
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("every GUARDED handler's body calls both inactive predicates the expected number of times (one per branch)", () => {
  const source = readFileSync(BROKER_SRC, "utf8");
  for (const name of GUARDED_INACTIVE_HANDLERS) {
    const body = stripComments(extractFunctionBody(source, name));
    const expected = EXPECTED_INACTIVE_GUARD_CALL_COUNTS[name]!;
    expect([name, countOccurrences(body, "refusesInactiveClaim(")]).toEqual([name, expected.claim]);
    expect([name, countOccurrences(body, "refusesInactiveToggle(")]).toEqual([name, expected.toggle]);
  }
});

test("every READ-ONLY handler's body writes neither UPDATE nor INSERT on roadmap_items", () => {
  const source = readFileSync(BROKER_SRC, "utf8");
  for (const name of READ_ONLY_INACTIVE_HANDLERS) {
    const body = extractFunctionBody(source, name);
    expect([name, body.includes("UPDATE roadmap_items")]).toEqual([name, false]);
    expect([name, body.includes("INSERT INTO roadmap_items")]).toEqual([name, false]);
  }
});

test("no replication write handler assigns the lock column, which is what exempts it from the claim guard", () => {
  const source = readFileSync(BROKER_SRC, "utf8");
  for (const name of REPLICATION_INACTIVE_HANDLERS) {
    const body = stripComments(extractFunctionBody(source, name));
    // `locked` may appear as a column NAME in an insert list (written as the
    // literal 0); what must never appear is an assignment of a lock value.
    // The lookahead keeps a COMPARISON (`locked === 1`, how the push reads the
    // upstream lock before refusing a write behind it) out of the match: a
    // read of the column is the opposite of the write this guards against.
    expect([name, /locked\s*=(?!=)/.test(body)]).toEqual([name, false]);
    expect([name, /locked_by\s*=(?!=)/.test(body)]).toEqual([name, false]);
  }
});

test("every EXEMPT handler carries a one-line justification citing this card", () => {
  const source = readFileSync(BROKER_SRC, "utf8");
  for (const name of EXEMPT_INACTIVE_HANDLERS) {
    const idx = source.search(new RegExp(`(?:export )?function ${name}\\(`));
    expect([name, idx]).not.toEqual([name, -1]);
    // The exemption comment sits directly above the function declaration, not
    // inside its body -- extractFunctionBody would miss it entirely, so this
    // reads the window of source immediately BEFORE the signature instead.
    const before = source.slice(Math.max(0, idx - 500), idx);
    expect([name, before.includes("c33a5968")]).toEqual([name, true]);
  }
});
