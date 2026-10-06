import { expect, test } from "bun:test";
import {
  countLiveSessions,
  createSpawnCap,
  sanitizeSpawnCap,
  SPAWN_CAP,
  SPAWN_CAP_MAX,
  SPAWN_CAP_MIN,
  type SpawnCapSource
} from "../desktop/src/main/spawn-cap";

test("countLiveSessions excludes exited Deck sessions", () => {
  expect(
    countLiveSessions([
      { status: "running" },
      { status: "exited" },
      { status: "starting" }
    ])
  ).toBe(2);
});

test("agent batches reserve capacity until their creation completes", () => {
  const sessions = Array.from({ length: SPAWN_CAP - 1 }, () => ({ status: "running" }));
  const cap = createSpawnCap(() => sessions);

  const release = cap.reserve(1);
  expect(() => cap.reserve(1)).toThrow("spawn cap");

  release();
  expect(() => cap.reserve(1)).not.toThrow();
});

test("a refusal caused only by in-flight reservations asks to retry, not to close sessions", () => {
  const sessions = Array.from({ length: SPAWN_CAP - 2 }, () => ({ status: "running" }));
  const cap = createSpawnCap(() => sessions);
  cap.reserve(2);

  let message = "";
  try {
    cap.reserve(1);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("awaiting approval or creation");
  expect(message).toContain("retry");
  expect(message).not.toContain("close sessions");
});

test("a refusal caused by live sessions alone asks to close sessions", () => {
  const sessions = Array.from({ length: SPAWN_CAP }, () => ({ status: "running" }));
  const cap = createSpawnCap(() => sessions);

  expect(() => cap.reserve(1)).toThrow("close sessions");
});

test("releasing a reservation twice frees its slots only once", () => {
  const sessions = Array.from({ length: SPAWN_CAP - 2 }, () => ({ status: "running" }));
  const cap = createSpawnCap(() => sessions);
  const release = cap.reserve(1);
  cap.reserve(1);

  release();
  release();
  cap.reserve(1);
  expect(() => cap.reserve(1)).toThrow("spawn cap");
});

test("reserve rejects a requested count that is not a positive integer and leaves the reservation intact", () => {
  const sessions = Array.from({ length: SPAWN_CAP - 2 }, () => ({ status: "running" }));
  const cap = createSpawnCap(() => sessions);

  for (const invalid of [NaN, -1, 0, 0.5, Infinity]) {
    expect(() => cap.reserve(invalid)).toThrow("positive integer");
  }

  cap.reserve(2);
  expect(() => cap.reserve(1)).toThrow("spawn cap");
});

function liveSetting(getCap: () => unknown, invalid: unknown[] = []): SpawnCapSource {
  return { getCap, onInvalidCap: (value) => invalid.push(value) };
}

test("a cap setting that is not a valid cap never disables the cap: SPAWN_CAP applies and the value is traced", () => {
  for (const broken of [NaN, undefined, "16", Infinity, 2.5, 0, SPAWN_CAP_MAX + 1]) {
    const sessions = Array.from({ length: SPAWN_CAP }, () => ({ status: "running" }));
    const invalid: unknown[] = [];
    const cap = createSpawnCap(() => sessions, liveSetting(() => broken, invalid));

    expect(() => cap.reserve(1), `getCap() -> ${String(broken)}`).toThrow(`exceeds the ${SPAWN_CAP} cap`);
    expect(invalid, `getCap() -> ${String(broken)} is traced`).toEqual([broken]);

    sessions.pop();
    expect(() => cap.reserve(1), `getCap() -> ${String(broken)} still allows up to SPAWN_CAP`).not.toThrow();
  }
});

test("the cap getter is re-read at every reserve, so a lowered setting refuses the next spawn", () => {
  const sessions = [{ status: "running" }, { status: "running" }];
  let setting = 8;
  const cap = createSpawnCap(() => sessions, liveSetting(() => setting));
  cap.reserve(1)();

  setting = 2;
  expect(() => cap.reserve(1)).toThrow("exceeds the 2 cap");
});

test("lowering the cap below the live session count closes nothing and refuses only new spawns", () => {
  const sessions = Array.from({ length: 5 }, () => ({ status: "running" }));
  let setting = 8;
  const cap = createSpawnCap(() => sessions, liveSetting(() => setting));

  setting = 2;
  expect(() => cap.reserve(1)).toThrow("close sessions");
  expect(sessions).toHaveLength(5);

  setting = 6;
  expect(() => cap.reserve(1)).not.toThrow();
});

test("a reservation granted before the cap is lowered stays granted and is released normally", () => {
  const sessions = [{ status: "running" }];
  let setting = 8;
  const cap = createSpawnCap(() => sessions, liveSetting(() => setting));
  const release = cap.reserve(4);

  setting = 4;
  expect(() => cap.reserve(1)).toThrow("spawn cap");
  release();
  expect(() => cap.reserve(3)).not.toThrow();
});

test("sanitizeSpawnCap keeps an integer within the bounds", () => {
  expect(sanitizeSpawnCap(SPAWN_CAP_MIN)).toBe(SPAWN_CAP_MIN);
  expect(sanitizeSpawnCap(SPAWN_CAP)).toBe(SPAWN_CAP);
  expect(sanitizeSpawnCap(SPAWN_CAP_MAX)).toBe(SPAWN_CAP_MAX);
});

test("sanitizeSpawnCap rejects every value that would disable or distort the cap", () => {
  for (const invalid of [
    NaN,
    Infinity,
    -Infinity,
    2.5,
    0,
    -1,
    SPAWN_CAP_MIN - 1,
    SPAWN_CAP_MAX + 1,
    "8",
    null,
    undefined,
    true,
    {},
    [8]
  ]) {
    expect(sanitizeSpawnCap(invalid), `sanitizeSpawnCap(${String(invalid)})`).toBeNull();
  }
});
