import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  teamLeadInstanceToken,
  teamLeadMcpFilePrefix,
  teamLeadMcpConfigFileName,
  isSweepableTeamLeadMcpFile,
  sweepTeamLeadMcpConfigs,
  type TeamLeadMcpSweepDeps
} from "../desktop/src/main/team-lead-mcp-sweep";
import { extractBracedBody } from "./_braced-body";

const PROJECT_A = "local:aaaaaaaaaaaaaaaa";
const PROJECT_B = "local:bbbbbbbbbbbbbbbb";

function fakeFs(files: string[]): { deps: TeamLeadMcpSweepDeps; removed: string[]; fileErrors: string[] } {
  const removed: string[] = [];
  const fileErrors: string[] = [];
  const deps: TeamLeadMcpSweepDeps = {
    dirExists: () => true,
    listFiles: () => files,
    removeFile: (_dir, name) => {
      removed.push(name);
    },
    onFileError: (name) => {
      fileErrors.push(name);
    },
    onScanError: () => {}
  };
  return { deps, removed, fileErrors };
}

test("two different project keys derive two different instance tokens", () => {
  expect(teamLeadInstanceToken(PROJECT_A)).not.toBe(teamLeadInstanceToken(PROJECT_B));
});

test("a file this instance wrote for itself is sweepable by itself", () => {
  const token = teamLeadInstanceToken(PROJECT_A);
  const name = teamLeadMcpConfigFileName(token, "team-lead-xyz");
  expect(isSweepableTeamLeadMcpFile(name, token)).toBe(true);
});

test("card 9d8e24f4: a live sibling instance's file (different project dir) is never swept", () => {
  const tokenA = teamLeadInstanceToken(PROJECT_A);
  const tokenB = teamLeadInstanceToken(PROJECT_B);
  const liveFileFromInstanceA = teamLeadMcpConfigFileName(tokenA, "team-lead-live-tile");

  const startupSweepCandidatesForInstanceB = [liveFileFromInstanceA].filter((name) =>
    isSweepableTeamLeadMcpFile(name, tokenB)
  );

  expect(
    startupSweepCandidatesForInstanceB,
    "instance B's startup sweep must never select a file whose prefix names a DIFFERENT project directory (instance A) -- that file may back a currently-live team-lead tile in instance A, and deleting it silently drops that tile's deck-control bridge on its next relaunch"
  ).toEqual([]);
});

test("a pre-fix unprefixed team-lead-mcp-*.json file is left alone (accumulates rather than risks a live sibling)", () => {
  const token = teamLeadInstanceToken(PROJECT_A);
  expect(isSweepableTeamLeadMcpFile("team-lead-mcp-some-caller-id.json", token)).toBe(false);
});

test("teamLeadMcpConfigFileName and teamLeadMcpFilePrefix agree: every generated name starts with the prefix", () => {
  const token = teamLeadInstanceToken(PROJECT_A);
  const name = teamLeadMcpConfigFileName(token, "team-lead-abc");
  expect(name.startsWith(teamLeadMcpFilePrefix(token))).toBe(true);
});

// ----- sweepTeamLeadMcpConfigs: the full startup-sweep body, fs injected -----

test("card 9d8e24f4: sweeping as instance B removes only B's own stale file, never A's live one", () => {
  const tokenA = teamLeadInstanceToken(PROJECT_A);
  const tokenB = teamLeadInstanceToken(PROJECT_B);
  const liveFileFromA = teamLeadMcpConfigFileName(tokenA, "team-lead-live-tile");
  const staleFileFromB = teamLeadMcpConfigFileName(tokenB, "team-lead-dead-run");
  const { deps, removed } = fakeFs([liveFileFromA, staleFileFromB]);

  sweepTeamLeadMcpConfigs("/state", tokenB, deps);

  expect(
    removed,
    "instance B's sweep must remove its own stale file and nothing belonging to instance A's project directory"
  ).toEqual([staleFileFromB]);
});

test("sweepTeamLeadMcpConfigs skips a non-matching name entirely (no removeFile call)", () => {
  const token = teamLeadInstanceToken(PROJECT_A);
  const { deps, removed } = fakeFs(["supervisor-mcp.json", "team-lead-mcp-some-caller-id.json"]);

  sweepTeamLeadMcpConfigs("/state", token, deps);

  expect(removed).toEqual([]);
});

test("sweepTeamLeadMcpConfigs reports a per-file error without aborting the rest of the loop", () => {
  const token = teamLeadInstanceToken(PROJECT_A);
  const ok = teamLeadMcpConfigFileName(token, "caller-ok");
  const bad = teamLeadMcpConfigFileName(token, "caller-bad");
  const removed: string[] = [];
  const fileErrors: string[] = [];
  const deps: TeamLeadMcpSweepDeps = {
    dirExists: () => true,
    listFiles: () => [bad, ok],
    removeFile: (_dir, name) => {
      if (name === bad) throw new Error("EPERM");
      removed.push(name);
    },
    onFileError: (name) => fileErrors.push(name),
    onScanError: () => {}
  };

  sweepTeamLeadMcpConfigs("/state", token, deps);

  expect(fileErrors).toEqual([bad]);
  expect(removed).toEqual([ok]);
});

test("sweepTeamLeadMcpConfigs does nothing when the state dir does not exist yet", () => {
  const token = teamLeadInstanceToken(PROJECT_A);
  let listCalled = false;
  const deps: TeamLeadMcpSweepDeps = {
    dirExists: () => false,
    listFiles: () => {
      listCalled = true;
      return [];
    },
    removeFile: () => {},
    onFileError: () => {},
    onScanError: () => {}
  };

  sweepTeamLeadMcpConfigs("/state", token, deps);

  expect(listCalled).toBe(false);
});

// ----- call-site wiring: does index.ts's sweepStaleTeamLeadMcpConfigs -----
// ----- actually delegate to sweepTeamLeadMcpConfigs above? -----
// index.ts is not bun-test-importable (electron), so this extracts the real
// declaration body and executes it via `new Function` rather than a source
// scan. Brace-matched, not a sliding regex: findMatchingClose can only
// consume THIS declaration's own nesting, it cannot cross into a sibling
// function's body the way an unbounded `[\s\S]*` scan could.

const INDEX_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
const SWEEP_ANCHOR = "const sweepStaleTeamLeadMcpConfigs = (): void => {";

/** Fails closed on the anchor count itself: 0 or more than 1 is refused, never silently takes the first. */
function extractSweepDeclarationBody(src: string): string {
  const occurrences = src.split(SWEEP_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `index.ts: expected exactly 1 occurrence of "${SWEEP_ANCHOR}", found ${occurrences} -- ` +
        "has sweepStaleTeamLeadMcpConfigs been renamed, duplicated, or reshaped?"
    );
  }
  const anchorIdx = src.indexOf(SWEEP_ANCHOR);
  const openBraceIdx = anchorIdx + SWEEP_ANCHOR.length - 1;
  return extractBracedBody(src, openBraceIdx);
}

test("card 9d8e24f4 wiring: index.ts's sweepStaleTeamLeadMcpConfigs delegates to the real sweepTeamLeadMcpConfigs, extracted from the real file and executed", () => {
  const src = readFileSync(INDEX_PATH, "utf-8");
  const body = extractSweepDeclarationBody(src);

  const calls: Array<{ dir: string; instanceToken: string; depsKeys: string[] }> = [];
  const spySweep = (dir: string, instanceToken: string, deps: Record<string, unknown>) => {
    calls.push({ dir, instanceToken, depsKeys: Object.keys(deps).sort() });
  };

  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const run = new Function(
    "join",
    "app",
    "APP_STATE_SUBDIR",
    "sweepTeamLeadMcpConfigs",
    "instanceToken",
    "existsSync",
    "readdirSync",
    "unlinkSync",
    "reportError",
    body
  ) as (
    joinFn: typeof join,
    app: { getPath: (name: string) => string },
    stateSubdir: string,
    sweep: typeof spySweep,
    token: string,
    existsSync: (p: string) => boolean,
    readdirSync: (p: string) => string[],
    unlinkSync: (p: string) => void,
    reportError: (...args: unknown[]) => void
  ) => void;

  run(
    join,
    { getPath: (name) => (name === "userData" ? "/fake/userData" : (() => { throw new Error(`unexpected getPath(${name})`) })()) },
    "config",
    spySweep,
    "FAKE_INSTANCE_TOKEN",
    () => true,
    () => [],
    () => {},
    () => {}
  );

  expect(
    calls,
    "sweepStaleTeamLeadMcpConfigs must delegate to the real sweepTeamLeadMcpConfigs exactly once, with the resolved dir/instanceToken and a 5-key fs-deps object -- an inline loop reimplemented here instead of calling it would never reference the injected sweepTeamLeadMcpConfigs identifier, so calls would stay empty"
  ).toEqual([
    {
      dir: join("/fake/userData", "config"),
      instanceToken: "FAKE_INSTANCE_TOKEN",
      depsKeys: ["dirExists", "listFiles", "onFileError", "onScanError", "removeFile"]
    }
  ]);
});
