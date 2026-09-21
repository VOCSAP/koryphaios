// The content contract of a roadmap card is written TWICE -- once for the
// broker, once for the Deck -- in two files with no import relation, so the
// compiler cannot pair them. Editing one alone leaves a field that is
// replicated on one side and ignored on the other, with every other test in
// the suite still green: the divergence only shows up as a card whose value
// travels in one direction.
// These guards are the pairing. They compare the two declarations to each
// other, never each one to a hardcoded list, so they keep biting as the
// contract grows.

import { test, expect } from "bun:test";
import {
  ROADMAP_SYNC_CONTENT_FIELDS as CORE_FIELDS,
  ROADMAP_TRIAGE_ROLES,
  type RoadmapItem,
  type RoadmapSyncContent,
} from "../shared/types.ts";
import { ROADMAP_SYNC_CONTENT_FIELDS as DECK_FIELDS } from "../desktop/src/shared/types.ts";
import { pickSyncContent } from "../shared/roadmap-sync.ts";

test("the Deck's content contract holds exactly the core's fields, in the same order", () => {
  // Order-sensitive on purpose: the core list also generates the SQL trigger's
  // column list and its WHEN clause, so a reordering is a real difference
  // between the two files even though it changes no membership.
  expect([...DECK_FIELDS]).toEqual([...CORE_FIELDS] as unknown as typeof DECK_FIELDS[number][]);
});

test("neither side declares a field the other does not", () => {
  const core = new Set<string>(CORE_FIELDS);
  const deck = new Set<string>(DECK_FIELDS);
  const missingFromDeck = [...core].filter((f) => !deck.has(f));
  const missingFromCore = [...deck].filter((f) => !core.has(f));
  expect([
    "fields the Deck mirror is missing (a local edit that never reaches the operator's board)",
    missingFromDeck,
  ]).toEqual([
    "fields the Deck mirror is missing (a local edit that never reaches the operator's board)",
    [],
  ]);
  expect([
    "fields only the Deck knows (a field the broker never replicates)",
    missingFromCore,
  ]).toEqual(["fields only the Deck knows (a field the broker never replicates)", []]);
});

test("the guard inspects a real contract, not an empty one", () => {
  // Both lists resolving to [] would make every comparison above pass
  // vacuously; the floor is well under the current size so the contract can
  // shrink honestly, and nowhere near zero.
  expect(CORE_FIELDS.length).toBeGreaterThanOrEqual(10);
  expect(DECK_FIELDS.length).toBeGreaterThanOrEqual(10);
});

test("pickSyncContent carries every declared field, so the snapshot cannot lag the contract", () => {
  const source: RoadmapSyncContent = {
    kind: "feature",
    title: "t",
    description: "d",
    rationale: "r",
    context: "c",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    triage: "ready-for-agent",
    tags: ["a"],
    depends_on: [],
    deleted_at: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
  };
  expect(Object.keys(pickSyncContent(source)).sort()).toEqual([...CORE_FIELDS].sort());
});

test("triage is a content field: a role that does not replicate is a role two brokers disagree on", () => {
  // Pinned by name rather than left to the two comparisons above: dropping
  // `triage` from BOTH lists would keep them equal and silently make the role
  // local to each broker, which is the defect the queue column already paid
  // for once.
  expect([...CORE_FIELDS]).toContain("triage");
  expect([...DECK_FIELDS]).toContain("triage");
});

test("every triage role is a value the card type accepts", () => {
  // The list and the type are derived from one another core-side; this pins
  // the vocabulary itself, so dropping a role is a decision, not a typo.
  const roles: RoadmapItem["triage"][] = [...ROADMAP_TRIAGE_ROLES];
  expect(roles).toEqual([
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
  ]);
});
