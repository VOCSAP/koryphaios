import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// This file is not a guard on any production line: it characterizes ConPTY's
// own write-coalescing behavior, not the product's.
// Fixture assertions read captured pty journals; the live ConPTY probe (Windows
// only) re-measures coalescing directly and is skipped, by name, when the
// platform or node-pty build can't run it.

const REPO = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "pty-harness", "fixtures");
// The real executable, not the .bin shim: spawnSync without a shell cannot run
// a .cmd wrapper on Windows, and a shim that fails to start would look exactly
// like a failed measurement.
const ELECTRON = join(
  REPO,
  "desktop",
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron"
);
const PROBE = join(import.meta.dir, "pty-harness", "coalescing-probe.cjs");

type Chunk = { t: number; data: string };
const load = (name: string): Chunk[] => JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
const JOURNALS = ["turn-chunks-inherited-env.json", "turn-chunks-scrubbed-env.json"];

// ---------------------------------------------------------------- fixtures

test("the captured turns are real journals, not empty files", () => {
  for (const name of JOURNALS) {
    const chunks = load(name);
    const bytes = chunks.reduce((a, c) => a + c.data.length, 0);
    expect({ name, enough: chunks.length > 50 && bytes > 4000 }).toEqual({ name, enough: true });
  }
});

// The measurement that killed the "add the live wording to the pattern" family
// of fixes: the interrupt hint is not in the stream AT ALL during a turn. The
// CLI repaints that line partially, jumping over the unchanged hint with a
// cursor-forward, so it is on SCREEN and absent from the WIRE.
test("no interrupt hint is ever emitted during a real turn (both captures)", () => {
  for (const name of JOURNALS) {
    const all = load(name).map((c) => c.data).join("").toLowerCase();
    expect({ name, esc: all.split("esc").length - 1, interrupt: all.split("interrupt").length - 1 })
      .toEqual({ name, esc: 0, interrupt: 0 });
  }
});

test("the braille spinner is never emitted either -- the spinner is drawn with U+2600..U+27BF glyphs", () => {
  for (const name of JOURNALS) {
    const all = load(name).map((c) => c.data).join("");
    const braille = [...all].filter((ch) => ch.codePointAt(0)! >= 0x2800 && ch.codePointAt(0)! <= 0x28ff);
    const dingbats = [...all].filter((ch) => ch.codePointAt(0)! >= 0x2600 && ch.codePointAt(0)! <= 0x27bf);
    expect({ name, braille: braille.length, dingbatsSeen: dingbats.length > 0 })
      .toEqual({ name, braille: 0, dingbatsSeen: true });
  }
});

// Why a space-anchored predicate on a CSI-stripped chunk cannot match a repaint
// frame: the inter-word gaps are cursor-forward sequences, not 0x20 bytes.
test("inter-word gaps in repaint frames are CSI n C cursor-forwards, not spaces", () => {
  for (const name of JOURNALS) {
    const all = load(name).map((c) => c.data).join("");
    const cuf = [...all.matchAll(new RegExp(String.fromCharCode(27) + "\\[([0-9]*)C", "g"))];
    const standIn = cuf.filter((m) => {
      const before = all.slice(Math.max(0, m.index! - 1), m.index!);
      const after = all.slice(m.index! + m[0].length, m.index! + m[0].length + 1);
      return /[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after);
    });
    expect({ name, manyGaps: standIn.length > 50 }).toEqual({ name, manyGaps: true });
    // and the classic consequence, spelled out on a real slice
    const stripped = all.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[ -/]*[@-~]", "g"), "");
    expect(stripped).toContain("Tipsforgettingstarted");
    expect(stripped).not.toContain("Tips for getting started");
  }
});

// ------------------------------------------- non-nominal UI state (reserve)

// The reserve stated on the fix: bracketed paste is a mode the CLI can have
// OFF, and injectCommand is the operator-directive path, so it can land on a
// tile that is not at its main prompt. These two captures replay injectCommand
// against the cheapest non-nominal state reachable without spending an API
// turn -- the trust/confirm dialog a fresh directory opens with -- and pin what
// the code comment claims.

test("the CLI enables bracketed paste at startup, so the encoding the fix relies on is armed", () => {
  const all = (JSON.parse(readFileSync(join(FIXTURES, "dialog-open-no-esc.json"), "utf-8")) as Chunk[])
    .map((c) => c.data)
    .join("");
  expect(all).toContain(`${String.fromCharCode(27)}[?2004h`);
});

test("with a dialog open the paste is silently swallowed: no submission, and NO literal marker on screen", () => {
  const all = (JSON.parse(readFileSync(join(FIXTURES, "dialog-open-no-esc.json"), "utf-8")) as Chunk[])
    .map((c) => c.data)
    .join("");
  // The payload never reaches the screen and nothing is submitted: a lost
  // command, not a corrupted terminal. The second half is the one that matters
  // -- a leaked "200~" would mean the terminal took the markers as text.
  expect({ echoed: all.includes("reply-E-"), marker: all.includes("200~") })
    .toEqual({ echoed: false, marker: false });
});

test("the bare ESC that PREDATES this card quits the CLI when that dialog is on screen", () => {
  const chunks = JSON.parse(readFileSync(join(FIXTURES, "dialog-open-with-esc.json"), "utf-8")) as Chunk[];
  const all = chunks.map((c) => c.data).join("");
  const esc = String.fromCharCode(27);
  // Teardown signature, in order: bracketed paste turned OFF, then the payload
  // echoed RAW by the console because no application is left to consume it.
  const off = all.indexOf(`${esc}[?2004l`);
  const rawEcho = all.indexOf("reply-E-");
  expect({ turnedPasteOff: off !== -1, echoedRawAfter: rawEcho > off })
    .toEqual({ turnedPasteOff: true, echoedRawAfter: true });
});

// ------------------------------------------------------- probe classifier

// classify() takes phase A and phase B as separate buffers rather than reading
// one flat array by position: a phase-A chunk split shifts every index after it
// and would misattribute a failure to phase B.
const probeModule = require(PROBE) as {
  classify: (outA: string, outB: string) => { lensA: number[]; lensB: number[]; coalesced: boolean; separated: boolean };
};
const { classify } = probeModule;

test("classify() does not blame phase B for a phase-A miss (the false-accusation bug this file used to have)", () => {
  // The exact captured miss shape: phase A's 240-byte write arrived as two
  // reads (239 then 1) instead of coalescing into one, while phase B (writes
  // 120ms apart) separated cleanly as always.
  const missedPhaseA = 'CHUNK len=239 "x"\nCHUNK len=1 "\\r"\n';
  const cleanPhaseB = 'CHUNK len=240 "Bx"\nCHUNK len=1 "\\r"\n';
  const { coalesced, separated } = classify(missedPhaseA, cleanPhaseB);
  // coalesced=false is the CORRECT read of a genuine race miss -- this test
  // is not asserting the race away, only that phase B's own, unrelated,
  // deterministic result is read correctly regardless of what phase A did.
  expect({ coalesced, separated }).toEqual({ coalesced: false, separated: true });
});

test("classify() still reports a real phase-B failure (not swallowed by the fix above)", () => {
  const coalescedPhaseA = 'CHUNK len=240 "x"\n';
  const brokenPhaseB = 'CHUNK len=241 "Bx"\n'; // did not separate at all: one read, wrong length
  const { coalesced, separated } = classify(coalescedPhaseA, brokenPhaseB);
  expect({ coalesced, separated }).toEqual({ coalesced: true, separated: false });
});

// --------------------------------------------------------------- live probe

const canProbe = process.platform === "win32" && existsSync(ELECTRON) && existsSync(PROBE);
const skipReason =
  process.platform !== "win32"
    ? `platform is ${process.platform}, write coalescing measured here is a ConPTY property`
    : !existsSync(ELECTRON)
      ? "desktop/node_modules is not installed, the Electron-ABI node-pty cannot be loaded"
      : "probe script missing";

const probeTest = canProbe ? test : test.skip;

// Phase A (coalescing) is retried across a bounded number of trials since it's
// a genuinely non-deterministic ConPTY property; phase B (separated writes) is
// checked once per attempt with no retry, since it's deterministic.
probeTest(
  canProbe
    ? "ConPTY coalesces back-to-back pty writes into one read within a bounded number of trials, and separates delayed writes on every trial"
    : `SKIPPED (${skipReason}): ConPTY write-coalescing probe`,
  () => {
    const MAX_ATTEMPTS = 5;
    let coalescedSeen = false;
    let attemptsRun = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attemptsRun = attempt;
      const r = spawnSync(ELECTRON, [PROBE], {
        // PROBE_NODE: the runtime the probe spawns INSIDE the pty. Bun's own
        // binary is the one guaranteed to exist here (it is running this test),
        // and it works as a console child; Electron-as-Node does not.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PROBE_NODE: process.execPath },
        encoding: "utf-8",
        timeout: 60_000,
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      // exit 2 = node-pty unavailable, exit 3 = the probe measured nothing at
      // all. Neither is a race outcome: fail hard here, on the first attempt
      // it happens, rather than retrying past it into a false green.
      expect(out).not.toContain("PROBE-UNAVAILABLE");
      expect(out).not.toContain("PROBE-MEASURED-NOTHING");
      expect(out).toContain("CHUNK_LENGTHS [");
      // Phase B is not racy (classifier tests above pin why a miss can never
      // land here by accident): any false is a real regression on THIS
      // attempt and must not be masked by a later successful attempt.
      expect(out).toContain("SEPARATED true");
      if (out.includes("COALESCED true")) {
        coalescedSeen = true;
        break;
      }
      // A single-trial miss of the coalescing race: expected ~13% of the
      // time, logged so a run's actual retry cost is visible in CI output
      // rather than only inferable from timing.
      console.log(`[pty-coalescing] attempt ${attempt}/${MAX_ATTEMPTS}: phase-A did not coalesce this trial, retrying`);
    }
    expect({ coalescedWithinAttempts: coalescedSeen, attemptsRun })
      .toEqual({ coalescedWithinAttempts: true, attemptsRun });
  },
  120_000
);
