import { expect, test } from "bun:test";
import {
  countLiveSessions,
  createSpawnCap,
  SPAWN_CAP
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
