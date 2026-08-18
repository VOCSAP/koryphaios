// Card 526665f7. Bun runs every test file in ONE process. A file that calls
// `GlobalRegistrator.register()` therefore hands its happy-dom globals to every
// file that runs after it, and the one that bites is `fetch`: happy-dom's
// applies the same-origin policy, Bun's native fetch does not. Every later
// suite that talks to a server it spawned on 127.0.0.1 is then refused with
// "Cross-Origin Request Blocked" and times out at 30 s or 60 s.
//
// This is a COVERAGE guard, not an illustration. It was written after the
// unpaired shape shipped once and cost three full-suite runs to attribute: the
// suite went from 1 fail / 166 s to 19 fail / 11 errors / 961 s, 20404 CORS
// lines, and NOT ONE of the extra red was in a file the batch had touched --
// which is precisely why it read as environmental for three runs and was
// blamed on live MCP servers. The pair
// tests/desktop-explorer-selection-dom.test.ts + tests/server-ask-operator.test.ts
// reproduces it alone: 5 fail / 4 errors / 7109 CORS lines / 300 s unpaired,
// against 10 pass / 0 CORS / 3.6 s paired.
//
// Discovery walks the tree instead of naming files, because the failure this
// guards against arrives with a file that does not exist yet. The two floor
// assertions below exist because a walk that silently returns nothing is the
// way this class of guard fails OPEN: it would stay green over an empty set.
import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const TESTS_DIR = import.meta.dir

/** This file itself: it quotes both markers in prose and would flag itself. */
const SELF = "desktop-happy-dom-teardown.test.ts"

/**
 * The two shapes that legitimately pair a `register()`.
 *
 * `unregister()` is the registrator's own API and restores on the way out.
 * The descriptor-restore shape (`Object.defineProperty(globalThis`, fed by a
 * snapshot taken before registering) restores DURING the file instead, which
 * tests/desktop-tile-area.test.ts needs because it asserts against Bun-native
 * globals while happy-dom is still mounted for react-dom. Either discharges
 * the obligation; neither is preferred here.
 */
const TEARDOWN_MARKERS = ["GlobalRegistrator.unregister(", "Object.defineProperty(globalThis"]

const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts") && f !== SELF)

test("the walk that feeds this guard actually sees the suite", () => {
  // Floor, not a count: if readdirSync ever returns a subset (renamed dir,
  // moved file, changed extension), every assertion below passes over nothing.
  expect(testFiles.length).toBeGreaterThan(100)
})

test("every test file that registers happy-dom globally also tears it down", () => {
  const registrants: string[] = []
  const unpaired: string[] = []

  for (const file of testFiles) {
    const source = readFileSync(join(TESTS_DIR, file), "utf8")
    if (!source.includes("GlobalRegistrator.register(")) continue
    registrants.push(file)
    if (!TEARDOWN_MARKERS.some((marker) => source.includes(marker))) unpaired.push(file)
  }

  // Second floor: the set of registrants must not be empty. An empty set makes
  // the real assertion below vacuously true, which is the same fail-open shape
  // the floor above closes one level up.
  expect(registrants.length).toBeGreaterThanOrEqual(2)

  expect(unpaired).toEqual([])
})

// The two tests above scan SOURCE TEXT: they see the NAME `unregister(`, never
// its effect, so they would stay green against a call that is present but inert
// (unawaited, dead-coded, or a registrator whose restore silently stopped
// working). This one exercises the real thing on the real globals. It is also
// why this file may register happy-dom at all: it discharges the very
// obligation it polices, in the same test, and the walk above skips it by name.
test("unregister() actually restores the global fetch that register() replaced", async () => {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  const nativeFetch = globalThis.fetch
  expect(GlobalRegistrator.isRegistered).toBe(false)

  GlobalRegistrator.register()
  // Load-bearing, not a warm-up: if happy-dom ever stops replacing `fetch`,
  // the restore assertion below becomes vacuously true and this whole guard
  // silently stops meaning anything. This line goes red first instead.
  expect(globalThis.fetch).not.toBe(nativeFetch)

  await GlobalRegistrator.unregister()
  expect(globalThis.fetch).toBe(nativeFetch)
  expect(GlobalRegistrator.isRegistered).toBe(false)
})
