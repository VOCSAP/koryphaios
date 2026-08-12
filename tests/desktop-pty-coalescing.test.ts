import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Card 6168b7f4. Two kinds of guard live here, on purpose:
//
//  1. FIXTURE assertions (always run, every platform). They read the raw pty
//     journals captured from real Claude Code turns on 2026-08-13 and assert
//     the facts the fix and its neighbouring diagnoses rest on. These are field
//     captures: they cannot re-measure the machine, but they CAN refute a future
//     claim about what the CLI puts on the wire, which is exactly what they are
//     kept for.
//
//  2. The LIVE ConPTY coalescing probe (Windows only). It re-measures the write
//     coalescing that makes the two-write shape fail. It is skipped -- by name,
//     with the reason in the test title -- when the platform is not win32 or
//     when desktop/node_modules is not installed, because the behaviour is a
//     ConPTY property and the probe needs the Electron-ABI node-pty. A skip that
//     announces itself is the point: a test that passes while measuring nothing
//     is the defect this repo tracks.

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

// --------------------------------------------------------------- live probe

const canProbe = process.platform === "win32" && existsSync(ELECTRON) && existsSync(PROBE);
const skipReason =
  process.platform !== "win32"
    ? `platform is ${process.platform}, write coalescing measured here is a ConPTY property`
    : !existsSync(ELECTRON)
      ? "desktop/node_modules is not installed, the Electron-ABI node-pty cannot be loaded"
      : "probe script missing";

const probeTest = canProbe ? test : test.skip;

probeTest(
  canProbe
    ? "ConPTY coalesces back-to-back pty writes into one read, and separates them when they are apart"
    : `SKIPPED (${skipReason}): ConPTY write-coalescing probe`,
  () => {
    const r = spawnSync(ELECTRON, [PROBE], {
      // PROBE_NODE: the runtime the probe spawns INSIDE the pty. Bun's own
      // binary is the one guaranteed to exist here (it is running this test),
      // and it works as a console child; Electron-as-Node does not.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PROBE_NODE: process.execPath },
      encoding: "utf-8",
      timeout: 60_000,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // Assert on the probe's OUTPUT first: when this fails, the diff then shows
    // what the probe actually said (which runtime it used, whether node-pty
    // loaded, what chunk lengths it saw) instead of a bare exit code.
    expect(out).toContain("COALESCED true");
    expect(out).toContain("SEPARATED true");
    // exit 2 = node-pty unavailable, exit 3 = the probe measured nothing at all.
    // Neither may be swallowed into a green: that is the failure mode this file
    // exists to prevent.
    expect({ code: r.status, sawLengths: /CHUNK_LENGTHS \[/.test(out) })
      .toEqual({ code: 0, sawLengths: true });
  },
  90_000
);
