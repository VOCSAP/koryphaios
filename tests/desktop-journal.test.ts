// PLAN C14: activity journal ring buffer (desktop/src/main/journal).

import { test, expect } from "bun:test";
import { Journal, JOURNAL_CAP } from "../desktop/src/main/journal.ts";

test("add/list accumulate in order with monotonic ids and the injected clock", () => {
  let clock = 1000
  const j = new Journal(10, () => clock)
  j.add("session", "a spawned")
  clock = 2000
  j.add("quota", "a limited")

  const all = j.list()
  expect(all.map((e) => e.text)).toEqual(["a spawned", "a limited"])
  expect(all.map((e) => e.at)).toEqual([1000, 2000])
  expect(all[1]!.id).toBeGreaterThan(all[0]!.id)
})

test("list(kind) filters; list() returns a copy (no aliasing)", () => {
  const j = new Journal(10, () => 0)
  j.add("session", "s1")
  j.add("worktree", "w1")
  j.add("session", "s2")

  expect(j.list("session").map((e) => e.text)).toEqual(["s1", "s2"])
  expect(j.list("announce")).toEqual([])

  const copy = j.list()
  copy.pop()
  expect(j.list().length).toBe(3)
})

test("the ring buffer caps at the configured size, dropping the oldest", () => {
  const j = new Journal(5, () => 0)
  for (let i = 1; i <= 8; i++) j.add("session", `e${i}`)
  const texts = j.list().map((e) => e.text)
  expect(texts).toEqual(["e4", "e5", "e6", "e7", "e8"])
  // Ids keep growing across the drop (they are not recycled).
  expect(j.list()[0]!.id).toBe(4)
})

test("toText renders one ISO line per entry", () => {
  const j = new Journal(10, () => Date.UTC(2026, 0, 2, 3, 4, 5))
  j.add("announce", "hello team")
  expect(j.toText()).toBe("2026-01-02T03:04:05.000Z  [announce]  hello team")
})

test("default cap constant is applied", () => {
  const j = new Journal(undefined as unknown as number, () => 0)
  // undefined -> default parameter JOURNAL_CAP
  for (let i = 0; i < JOURNAL_CAP + 20; i++) j.add("session", `e${i}`)
  expect(j.list().length).toBe(JOURNAL_CAP)
})
