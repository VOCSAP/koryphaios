import { test, expect } from "bun:test";
import {
  composeJoinAnnounce,
  defaultAnnounceDraft,
  JOIN_NO_REPLY_NOTE,
  type JoinAnnounceIntent
} from "../desktop/src/shared/announce.ts";

test("defaultAnnounceDraft summarises agent/model/effort with fallbacks", () => {
  expect(defaultAnnounceDraft({ agent: "developer", model: "opus", effort: "high" })).toBe(
    "agent: developer, model: opus, effort: high"
  );
  expect(defaultAnnounceDraft({ agent: "", model: "", effort: "" })).toBe(
    "agent: default, model: default, effort: auto"
  );
});

test("defaultAnnounceDraft names the bridge only when one carries the model", () => {
  expect(
    defaultAnnounceDraft({
      agent: "developer",
      model: "clodex:openai-oauth:gpt-5.6-sol",
      effort: "high",
      via: "clodex"
    })
  ).toBe("agent: developer, model: clodex:openai-oauth:gpt-5.6-sol, effort: high, via: clodex");
  // Absent or empty: the line keeps its three historical fields, unchanged for
  // every non-bridged session.
  expect(defaultAnnounceDraft({ agent: "a", model: "m", effort: "low", via: "" })).toBe(
    "agent: a, model: m, effort: low"
  );
  expect(defaultAnnounceDraft({ agent: "a", model: "m", effort: "low" })).toBe(
    "agent: a, model: m, effort: low"
  );
});

test("composeJoinAnnounce carries the bridge through the default path", () => {
  const intent: JoinAnnounceIntent = {
    custom: null,
    agent: "reviewer",
    model: "gpt-5.6-sol",
    effort: "",
    via: "clodex"
  };
  expect(composeJoinAnnounce("dev-pc-foo-2", intent)).toContain("via: clodex");
});

test("composeJoinAnnounce default path always includes the peer_id and the summary", () => {
  const intent: JoinAnnounceIntent = { custom: null, agent: "reviewer", model: "sonnet", effort: "" };
  const text = composeJoinAnnounce("dev-pc-foo-2", intent);
  expect(text).toContain('"dev-pc-foo-2"');
  expect(text).toContain("agent: reviewer");
  expect(text).toContain("model: sonnet");
  expect(text).toContain("effort: auto");
});

test("composeJoinAnnounce custom path keeps the peer_id head and appends the note", () => {
  const intent: JoinAnnounceIntent = {
    custom: "joining to help on the broker refactor",
    agent: "developer",
    model: "opus",
    effort: "high"
  };
  const text = composeJoinAnnounce("dev-1", intent);
  expect(text).toBe(
    `New peer "dev-1" joined the group. joining to help on the broker refactor\n${JOIN_NO_REPLY_NOTE}`
  );
});

test("composeJoinAnnounce treats a whitespace-only custom note as empty (default path)", () => {
  const intent: JoinAnnounceIntent = { custom: "   ", agent: "", model: "", effort: "" };
  const text = composeJoinAnnounce("peer-x", intent);
  expect(text).toBe(
    `New peer "peer-x" joined the group (agent: default, model: default, effort: auto).\n${JOIN_NO_REPLY_NOTE}`
  );
});

// PLAN K4: every join announce forbids replying AND greeting the newcomer --
// the broker-side deck note only forbids replying to 'deck', which left agents
// free to welcome the new peer via send_message.
test("every join announce carries the no-reply/no-greeting note", () => {
  for (const custom of [null, "custom note"]) {
    const text = composeJoinAnnounce("p", { custom, agent: "", model: "", effort: "" });
    expect(text).toContain("do NOT reply");
    expect(text).toContain("do NOT greet");
  }
});
