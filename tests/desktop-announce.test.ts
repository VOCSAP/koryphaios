import { test, expect } from "bun:test";
import {
  composeJoinAnnounce,
  defaultAnnounceDraft,
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
  expect(text).toBe('New peer "dev-1" joined the group. joining to help on the broker refactor');
});

test("composeJoinAnnounce treats a whitespace-only custom note as empty (default path)", () => {
  const intent: JoinAnnounceIntent = { custom: "   ", agent: "", model: "", effort: "" };
  const text = composeJoinAnnounce("peer-x", intent);
  expect(text).toBe('New peer "peer-x" joined the group (agent: default, model: default, effort: auto).');
});
