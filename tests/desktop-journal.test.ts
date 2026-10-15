import { test, expect } from "bun:test";
import { MAX_LOGGED_CHARS } from "../shared/log-redact.ts";
import { Journal, JOURNAL_CAP, type JournalEntry } from "../desktop/src/main/journal.ts";

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

test("add sends the completed entry to its synchronous persistence sink", () => {
  const written: JournalEntry[] = []
  const j = new Journal(10, () => 1000, (entry) => written.push(entry))

  j.add("quota", "session limited")

  expect(written).toEqual([{ id: 1, at: 1000, kind: "quota", text: "session limited" }])
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
  expect(j.list()[0]!.id).toBe(4)
})

test("every agent-controlled separator is neutralized before reaching a journal sink", () => {
  const replacement = String.fromCharCode(0xfffd)
  const carriageReturn = String.fromCharCode(13)
  const lineFeed = String.fromCharCode(10)
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => String.fromCharCode(from + index))
  const controls = [...range(0, 0x1f), ...range(0x7f, 0x9f)].filter((value) => value !== carriageReturn && value !== lineFeed)
  const bidi = [
    String.fromCharCode(0x061c),
    ...range(0x200b, 0x200f),
    ...range(0x202a, 0x202e),
    ...range(0x2060, 0x2069),
    String.fromCharCode(0xfeff),
  ]
  const cases: Array<readonly [string, string]> = [
    [carriageReturn, " / "],
    [lineFeed, " / "],
    [carriageReturn + lineFeed, " / "],
    [String.fromCharCode(0x2028), " / "],
    [String.fromCharCode(0x2029), " / "],
    ...controls.map((value) => [value, replacement] as const),
    ...bidi.map((value) => [value, replacement] as const),
  ]

  for (const [unsafe, safe] of cases) {
    const written: JournalEntry[] = []
    const journal = new Journal(10, () => 0, (entry) => written.push(entry))
    const entry = journal.add("announce", unsafe)

    expect(entry.text).toBe(safe)
    expect(written).toEqual([entry])
  }
})

test("caps expanded separators at the maximum logged length", () => {
  const entry = new Journal(10, () => 0).add("announce", String.fromCharCode(10).repeat(MAX_LOGGED_CHARS))

  expect(entry.text.length).toBeLessThanOrEqual(MAX_LOGGED_CHARS)
  expect(entry.text).not.toContain(String.fromCharCode(10))
})

test("ordinary journal text reaches the sink unchanged", () => {
  const written: JournalEntry[] = []
  const j = new Journal(10, () => 0, (entry) => written.push(entry))

  j.add("session", "session started")

  expect(written[0]!.text).toBe("session started")
  expect(j.toText()).toBe("1970-01-01T00:00:00.000Z  [session]  session started")
})

test("default cap constant is applied", () => {
  const j = new Journal(undefined as unknown as number, () => 0)
  for (let i = 0; i < JOURNAL_CAP + 20; i++) j.add("session", `e${i}`)
  expect(j.list().length).toBe(JOURNAL_CAP)
})
