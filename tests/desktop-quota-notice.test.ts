import { expect, test } from "bun:test";

import {
  QUOTA_NOTICE_DELAY_MS,
  createQuotaNoticeTracker,
  limitedSessionIds,
  listedQuotaEpisode,
  quotaNoticeEntry,
  type QuotaNoticeState
} from "../desktop/src/shared/quota-notice.ts";
import { inboxEntryKey } from "../desktop/src/shared/types.ts";

// A clock whose timers run only when the test advances it.
function fakeClock(start = 1_000_000) {
  let now = start;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    clock: {
      now: () => now,
      setTimer: (run: () => void, ms: number): number => {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimer: (handle: unknown): void => {
        timers.delete(handle as number);
      }
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    pending: (): number => timers.size
  };
}

function tracked(start?: number) {
  const fake = fakeClock(start);
  const states: QuotaNoticeState[] = [];
  const tracker = createQuotaNoticeTracker(fake.clock, (state) => states.push(state));
  return { fake, states, tracker };
}

// Mutants: the delay constant lowered; the notice shown at once when the episode opens.
test("an episode opens with an id of its start instant and is shown only after the delay of continuous episode", () => {
  const { fake, states, tracker } = tracked(5_000);
  tracker.observe(2);

  expect(states).toEqual([{ episode: { id: "quota:5000", startedAt: 5_000 }, shown: false }]);
  fake.advance(QUOTA_NOTICE_DELAY_MS - 1);
  expect(states).toHaveLength(1);
  fake.advance(1);
  expect(states.at(-1)).toEqual({ episode: { id: "quota:5000", startedAt: 5_000 }, shown: true });
});

// Mutant: a new episode opened on every count change (the id would move with X).
test("the count moving inside one episode keeps its id and announces nothing new", () => {
  const { fake, states, tracker } = tracked();
  tracker.observe(1);
  tracker.observe(3);
  fake.advance(10_000);
  tracker.observe(2);

  expect(states).toHaveLength(1);
  fake.advance(QUOTA_NOTICE_DELAY_MS);
  expect(states).toHaveLength(2);
  expect(states[0]!.episode!.id).toBe(states[1]!.episode!.id);
});

// Mutants: the timer left running when the episode closes; the close not published.
test("a flicker shorter than the delay is never shown", () => {
  const { fake, states, tracker } = tracked();
  tracker.observe(1);
  fake.advance(QUOTA_NOTICE_DELAY_MS - 1_000);
  tracker.observe(0);

  expect(states.at(-1)).toEqual({ episode: null, shown: false });
  expect(fake.pending()).toBe(0);
  fake.advance(QUOTA_NOTICE_DELAY_MS * 2);
  expect(states.some((s) => s.shown)).toBe(false);
});

test("zero limited tiles with no episode publishes nothing", () => {
  const { states, tracker } = tracked();
  tracker.observe(0);
  tracker.observe(0);
  expect(states).toEqual([]);
});

// Mutant: the episode id kept across a return to zero (an acknowledgement would hide the next episode).
test("a return to zero then a new limit starts a new episode with a new id, not yet shown", () => {
  const { fake, states, tracker } = tracked(1_000);
  tracker.observe(1);
  fake.advance(QUOTA_NOTICE_DELAY_MS);
  const first = states.at(-1)!;
  tracker.observe(0);
  fake.advance(500);
  tracker.observe(1);

  const second = states.at(-1)!;
  expect(first).toMatchObject({ shown: true });
  expect(second.shown).toBe(false);
  expect(second.episode!.id).not.toBe(first.episode!.id);
  expect(second.episode!.id).toBe(`quota:${1_000 + QUOTA_NOTICE_DELAY_MS + 500}`);
});

// Mutants: the entry key built from a fixed id; the acknowledged key ignored.
test("an acknowledgement hides its own episode only, and a hidden or unshown episode is not listed", () => {
  const first = { id: "quota:1000", startedAt: 1_000 };
  const second = { id: "quota:9000", startedAt: 9_000 };
  const acked = { [inboxEntryKey(quotaNoticeEntry(first, ""))]: "acked" as const };
  const seen = { [inboxEntryKey(quotaNoticeEntry(first, ""))]: "seen" as const };

  expect(listedQuotaEpisode(first, true, {})).toBe(first);
  expect(listedQuotaEpisode(first, true, seen), "opened is not acknowledged").toBe(first);
  expect(listedQuotaEpisode(first, true, acked)).toBeNull();
  expect(listedQuotaEpisode(second, true, acked), "the next episode is listed again").toBe(second);
  expect(listedQuotaEpisode(first, false, {})).toBeNull();
  expect(listedQuotaEpisode(null, true, {})).toBeNull();
});

test("the entry is an event stamped with the episode start, carrying the given text", () => {
  expect(quotaNoticeEntry({ id: "quota:86400000", startedAt: 86_400_000 }, "text")).toEqual({
    kind: "event",
    id: "quota:86400000",
    text: "text",
    at: "1970-01-02T00:00:00.000Z"
  });
});

// Mutant: the exited filter removed (an exited tile keeps rateLimited and would keep the episode open).
test("only live rate limited tiles are counted", () => {
  expect(
    limitedSessionIds([
      { id: "a", rateLimited: true, status: "running" },
      { id: "b", rateLimited: false, status: "running" },
      { id: "c", rateLimited: true, status: "exited" },
      { id: "d", status: "running" },
      { id: "e", rateLimited: true }
    ])
  ).toEqual(["a", "e"]);
});
