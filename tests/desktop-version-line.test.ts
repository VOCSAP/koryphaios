import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatVersionLine } from "../desktop/bin/version-line.js";

const VERSION = "0.13.0";
const DEGRADED = `koryphaios ${VERSION} (build inconnu)`;

test("build-info file absent (build is null) degrades to build inconnu", () => {
  expect(formatVersionLine(VERSION, null)).toBe(DEGRADED);
});

test("build-info JSON without a commit field degrades to build inconnu", () => {
  expect(formatVersionLine(VERSION, { builtAt: "2026-01-01T00:00:00.000Z" })).toBe(DEGRADED);
});

test("commit is an empty string degrades to build inconnu", () => {
  expect(
    formatVersionLine(VERSION, { commit: "", builtAt: "2026-01-01T00:00:00.000Z" })
  ).toBe(DEGRADED);
});

test("build-info without builtAt degrades to build inconnu", () => {
  expect(formatVersionLine(VERSION, { commit: "abc1234" })).toBe(DEGRADED);
});

test("dirty as the string \"false\" is not treated as dirty (strict === true)", () => {
  expect(
    formatVersionLine(VERSION, { commit: "abc1234", builtAt: "2026-01-01T00:00:00.000Z", dirty: "false" })
  ).toBe(`koryphaios ${VERSION} (abc1234, 2026-01-01T00:00:00.000Z)`);
});

test("commit value \"unknown\" (git unavailable at build time) still formats, not degraded", () => {
  expect(
    formatVersionLine(VERSION, { commit: "unknown", builtAt: "2026-01-01T00:00:00.000Z" })
  ).toBe(`koryphaios ${VERSION} (unknown, 2026-01-01T00:00:00.000Z)`);
});

test("dirty true appends the -dirty suffix", () => {
  expect(
    formatVersionLine(VERSION, { commit: "abc1234", builtAt: "2026-01-01T00:00:00.000Z", dirty: true })
  ).toBe(`koryphaios ${VERSION} (abc1234-dirty, 2026-01-01T00:00:00.000Z)`);
});

test("dirty false prints the plain commit with no suffix", () => {
  expect(
    formatVersionLine(VERSION, { commit: "abc1234", builtAt: "2026-01-01T00:00:00.000Z", dirty: false })
  ).toBe(`koryphaios ${VERSION} (abc1234, 2026-01-01T00:00:00.000Z)`);
});

test("a non-string commit degrades instead of formatting a garbage value", () => {
  expect(
    formatVersionLine(VERSION, { commit: 1234567, builtAt: "2026-01-01T00:00:00.000Z" })
  ).toBe(DEGRADED);
});

test("the writer and the reader agree on out/main as the build-stamp directory", () => {
  const launchSource = readFileSync(join(import.meta.dir, "..", "desktop", "bin", "launch.js"), "utf8");
  const writerSource = readFileSync(
    join(import.meta.dir, "..", "desktop", "scripts", "write-build-info.js"),
    "utf8"
  );
  const readsOutMain = /path\.resolve\(__dirname, ?'\.\.', ?'out', ?'main', ?'build-info\.json'\)/.test(
    launchSource
  );
  const writesOutMain = /path\.resolve\(__dirname, ?'\.\.', ?'out', ?'main'\)/.test(writerSource);
  expect(
    readsOutMain,
    "launch.js must read the build stamp from out/main: that is the only directory electron-vite's main build actually empties on every run, so a stamp anywhere else (e.g. out/ itself) survives an `electron-vite dev` on a newer commit and --version reports a stale hash instead of degrading"
  ).toBe(true);
  expect(
    writesOutMain,
    "write-build-info.js must write the build stamp into out/main: writer and reader must agree on the one directory electron-vite's main build actually empties, or a unilateral move on either side reintroduces the stale-hash regression with every test still green"
  ).toBe(true);
});
