import { test, expect, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  detectSerializationAccident,
  buildDecision,
  parseHookPayload,
} from "../desktop/hooks/roadmap-guard-hook.ts";

// Card 800b0fe3: guards the PreToolUse roadmap-markup-accident hook
// (desktop/hooks/roadmap-guard-hook.ts, built to
// desktop/deck-plugin/hooks/roadmap-guard-hook.mjs). Delivered and manually
// verified by the release-engineer via ad-hoc stdin pipes and headless
// runs -- nothing replays those. This file is that replay.
//
// RULE (2nd revision, 2026-08-24, post-review): a field carries ITS OWN
// closing tag (`</field>`) IMMEDIATELY followed by another parameter's
// opening tag (`<parameter name="X">`), no condition on X -- X can be any
// name, including a non-text field (tags, priority, ...) or a name this
// tool does not even have. An EARLIER revision instead required "opening
// tag naming a DIFFERENT known field that is itself empty" -- that
// conjunction was VACUOUS on `roadmap_update` (partial updates are the
// contract: most fields legitimately absent), silently exempted any
// accident naming a non-free-text field, and made the
// `roadmap_append_context` matcher permanently dead (its one field can
// never be its own "other" target). The close-then-open pair fixes all
// three at once. This file's 5 real samples were chosen specifically
// because each one is a measured instance of one of those defects, not an
// invented edge case (see the release-engineer's dispatch and the .ts
// source's own header for the measurement trail).
//
// WHICH ARTIFACT: the plugin executes the .mjs, not the .ts, so a source
// edit with no rebuild is invisible to any test that only imports the .ts.
// This file tests BOTH, deliberately, for different reasons:
//   - unit-level edge cases (no-preceding-close, no-known-field condition
//     on the target) import the .ts directly -- fast, precise, and these
//     are pure-function properties that do not depend on which artifact
//     ships. Decision: follow tests/approval-hook.test.ts's own precedent
//     (imports the sibling hook's .ts directly), per the team lead's
//     explicit call on this exact question.
//   - the FIVE real roadmap-sample payloads (the ones that actually decide
//     whether this hook is correct) are piped into the BUILT .mjs via a
//     real spawned process -- that is what a live Claude Code session
//     actually runs, so these are the only tests that can be wrong in the
//     way that matters.
//   - a dedicated FRESHNESS test rebuilds the .ts with the exact command
//     desktop/package.json's build:hook script uses and byte-diffs the
//     result against the checked-in .mjs, so a future source edit without
//     a rebuild is caught by name, not by accident (the team lead noted CI
//     itself always rebuilds and would never catch this drift locally --
//     tracked separately as its own roadmap card, not this file's job to
//     solve, only to detect for a developer running tests before pushing).
//
// FIXTURES: tests/fixtures/roadmap-guard/*.json are BYTE COPIES (md5-
// verified against the release-engineer's own probe files under
// ~/.agent-forge/scratch/pretooluse-probe/, never retyped) of FIVE real
// samples:
//   - b313f0c3 (accident, `rationale` swallowed the tag and the content
//     meant for `context`)                                     -> DENY
//   - 800b0fe3 (deliberate citation, incomplete tag fragment, no preceding
//     close, every field filled)                                -> PASS
//   - s1 (a PARTIAL `roadmap_update`, {id, description}, description cites
//     the tag syntax -- the exact false positive the FIRST revision's
//     conjunction produced, because "absent field" is the norm on a
//     partial update, not a signal)                             -> PASS
//   - s2 (accident whose opening tag names a NON-TEXT field, `tags` -- the
//     first revision's known-field check silently exempted this)  -> DENY
//   - s3 (accident on `roadmap_append_context`, whose SOLE field is `text`
//     -- the first revision's rule made this matcher permanently DEAD,
//     since a field can never accidentally swallow itself)         -> DENY
// The negative controls (800b0fe3, s1) are weighted exactly as heavily as
// the positive ones -- a hook that denies a valid call is worse than no
// hook, per the card's own framing.
//
// COVERAGE CROSS-CHECK, avoiding a sibling enumeration: hooks.json declares
// 3 PreToolUse matchers by hand, and the .ts source declares its own
// TOOL_TEXT_FIELDS key set by hand -- two independent hand-lists that could
// silently drift. Rather than adding a THIRD hand-list here, this file
// extracts BOTH sets structurally from the real files and compares them to
// each other, so a tool added to one but not the other is caught without
// this test ever knowing a tool's name in advance.
//
// Named tests/roadmap-guard-hook.test.ts, not approval-hook-prefixed and
// not broker-/server- prefixed: verified against
// scripts/pure-module-partition.ts's EXEMPTIONS table before naming (same
// check as tests/role-domain-sweep.test.ts's header) -- this file spawns no
// daemon and binds no port (short-lived `bun <file>.mjs` subprocesses that
// read stdin and exit, not a broker), so it belongs in the default
// "collected, clean" bucket, not an exemption bucket that (card f4a3ed1e:
// 52 test files run in NO CI job) is easy to fall into by name alone.

const DESKTOP_DIR = resolve(import.meta.dir, "..", "desktop");
const HOOK_TS = join(DESKTOP_DIR, "hooks", "roadmap-guard-hook.ts");
const HOOK_MJS = join(DESKTOP_DIR, "deck-plugin", "hooks", "roadmap-guard-hook.mjs");
const HOOKS_JSON = join(DESKTOP_DIR, "deck-plugin", "hooks", "hooks.json");
const FIXTURES_DIR = join(import.meta.dir, "fixtures", "roadmap-guard");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

interface DecisionOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

/** Spawns the REAL built .mjs with `stdinText` on stdin, returns its raw stdout. */
async function runHookMjs(stdinText: string, mjsPath: string = HOOK_MJS): Promise<string> {
  const proc = Bun.spawn(["bun", mjsPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  proc.stdin.write(stdinText);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

// --- End-to-end, real .mjs, 5 real payloads (the tests that decide correctness) ---

test(
  "real b313f0c3 accident payload (rationale's own </rationale> immediately followed by <parameter name=\"context\">) -> DENY",
  async () => {
    const out = await runHookMjs(loadFixture("payload-b313f0c3-accident.json"));
    expect(out.trim().length).toBeGreaterThan(0);
    const decision = JSON.parse(out) as DecisionOutput;
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain('"rationale"');
  },
  15_000
);

test(
  "real 800b0fe3 citation payload (incomplete tag fragment, no preceding close, every field filled) -> PASS, no decision",
  async () => {
    const out = await runHookMjs(loadFixture("payload-800b0fe3-citation.json"));
    expect(out).toBe("");
  },
  15_000
);

test(
  "real s1 payload: a PARTIAL roadmap_update ({id, description}) whose description cites the tag syntax -> PASS (the false positive the first rule produced)",
  async () => {
    const out = await runHookMjs(loadFixture("payload-s1-partial-citation.json"));
    expect(out).toBe("");
  },
  15_000
);

test(
  "real s2 payload: accident whose opening tag names a NON-TEXT field (tags) -> DENY (the first rule silently exempted this)",
  async () => {
    const out = await runHookMjs(loadFixture("payload-s2-nontext-target.json"));
    const decision = JSON.parse(out) as DecisionOutput;
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain("tags");
  },
  15_000
);

test(
  "real s3 payload: accident on roadmap_append_context (single field `text`) -> DENY (the first rule made this matcher permanently dead)",
  async () => {
    const out = await runHookMjs(loadFixture("payload-s3-append-context-accident.json"));
    const decision = JSON.parse(out) as DecisionOutput;
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain('"text"');
  },
  15_000
);

// --- Build freshness: catches a .ts edit that was never rebuilt into the .mjs ---
//
// CORRECTED PREMISE (team lead + debugger, 2026-08-24, after this test broke
// CI on all 3 OS legs): this is a BYTE pin on bun build's bundling output,
// which depends on the bun VERSION that produced it, not only on the source
// content -- measured live: bun 1.4.0 alphabetizes the `export {}` list,
// 1.3.13 does not, so the SAME source produces two different byte sequences
// depending on which bun built it. The first version of this comment got
// the consequence backwards: it said ".bun-version being pinned makes CI
// deterministic", which is true of the RUNNER, but says nothing about
// whether the COMMITTED ARTIFACT was itself produced by that pinned
// version. When it wasn't (as happened here: the checked-in .mjs was a
// 1.3.13 product, CI runs 1.4.0), the pin does not protect this test -- it
// makes it deterministically WRONG on every CI run, not deterministically
// right. What actually determines whether this comparison is meaningful is
// whether THIS PROCESS's own `Bun.version` matches `.bun-version`, checked
// below, not assumed.
//
// Consequence: this test SKIPS (visibly -- the local/pinned versions are
// baked into the test NAME itself, printed by bun test whether the test
// runs or is skipped) when the running bun does not match the repo's
// pinned `.bun-version`. On a match (always true in CI, since .bun-version
// IS what CI installs) the byte comparison runs exactly as before.
const PINNED_BUN_VERSION = readFileSync(
  join(import.meta.dir, "..", ".bun-version"),
  "utf-8"
).trim();
const BUN_VERSION_MATCHES_PIN = Bun.version === PINNED_BUN_VERSION;

// Belt-and-suspenders on visibility: measured live (bun 1.3.13) that
// `bun test`'s default reporter does NOT print a per-test "» <name>" line
// for a skipped test when the file also has passing tests -- only the
// aggregate "1 skip" count shows, which flags that SOMETHING was skipped
// but not why. The test NAME below still carries the reason for anyone who
// greps/opens the report, but a bare test count is not visible enough on
// its own, so this also unconditionally logs the reason at MODULE LOAD
// TIME (always runs, skipIf only skips the test BODY) -- printed regardless
// of bun version or reporter verbosity.
if (!BUN_VERSION_MATCHES_PIN) {
  console.warn(
    `[roadmap-guard-hook.test.ts] SKIPPING the .mjs freshness/byte-diff test: ` +
      `running Bun.version=${Bun.version} does not match pinned .bun-version=${PINNED_BUN_VERSION}. ` +
      `This is expected on a dev machine running a different local bun; it is not evidence of source drift.`
  );
}

test.skipIf(!BUN_VERSION_MATCHES_PIN)(
  `the checked-in .mjs is byte-identical to a fresh rebuild of the .ts (same command as build:hook)` +
    ` [pinned .bun-version=${PINNED_BUN_VERSION}, running Bun.version=${Bun.version}` +
    `${BUN_VERSION_MATCHES_PIN ? "" : " -- SKIPPED, versions differ, this comparison is meaningless here"}]`,
  async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "cp-roadmap-guard-rebuild-"));
  tmpDirs.push(scratchDir);
  const rebuiltPath = join(scratchDir, "roadmap-guard-hook.rebuild.mjs");

  // Exact same invocation as desktop/package.json's build:hook script for
  // this file (verified by reading that script, not assumed): `bun build
  // hooks/roadmap-guard-hook.ts --target=node --outfile=...`, run from
  // desktop/ as cwd (the relative `hooks/...` source path depends on it).
  const proc = Bun.spawn(
    ["bun", "build", "hooks/roadmap-guard-hook.ts", "--target=node", `--outfile=${rebuiltPath}`],
    { cwd: DESKTOP_DIR, stdout: "ignore", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`rebuild failed (exit ${exitCode}): ${stderr}`);
  }

  const rebuilt = readFileSync(rebuiltPath, "utf-8");
  const checkedIn = readFileSync(HOOK_MJS, "utf-8");
  expect(rebuilt).toBe(checkedIn);
});

// --- Fail-open, verified on the REAL spawned process, not just buildDecision ---
// Already independently confirmed by the reviewer on 4 inputs (non-JSON
// stdin, empty stdin, missing hook_event_name, a "tricky" tool_name) --
// replayed here so it stays a guard, not a one-off manual check.

test("real .mjs: a hook_event_name other than PreToolUse exits 0 with empty stdout", async () => {
  const out = await runHookMjs(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "mcp__claude-peers__roadmap_add",
      tool_input: { title: "x", description: '</description>\n<parameter name="rationale">' },
    })
  );
  expect(out).toBe("");
});

test("real .mjs: syntactically invalid JSON on stdin exits 0 with empty stdout (fail-open, not a crash)", async () => {
  const out = await runHookMjs("{ this is not valid json ");
  expect(out).toBe("");
});

test("real .mjs: empty stdin exits 0 with empty stdout", async () => {
  const out = await runHookMjs("");
  expect(out).toBe("");
});

test("real .mjs: a payload missing hook_event_name entirely exits 0 with empty stdout", async () => {
  const out = await runHookMjs(
    JSON.stringify({ tool_name: "mcp__claude-peers__roadmap_add", tool_input: { title: "x" } })
  );
  expect(out).toBe("");
});

// --- Unit-level edge cases on the pure functions (fast, precise) ---

test("parseHookPayload degrades malformed/empty stdin to {} instead of throwing", () => {
  expect(parseHookPayload("")).toEqual({});
  expect(parseHookPayload("not json")).toEqual({});
  expect(parseHookPayload("null")).toEqual({});
});

test("an opening tag with NO preceding closing tag of the field itself is not flagged (the citation shape)", () => {
  const m = detectSerializationAccident("mcp__claude-peers__roadmap_add", {
    title: "t",
    description: 'mentions `<parameter name="rationale">` as an example, nothing closed here',
    rationale: "r",
    context: "c",
  });
  expect(m).toBeNull();
});

test("the opening tag's target has NO condition -- an unknown/made-up field name still flags", () => {
  // Behavioral proof that the new rule dropped the "target is a known field"
  // check entirely: a target name this tool has never heard of ("bogus_field")
  // must still DENY, exactly like card s2's real "tags" (a real, but
  // non-text, field) did against the .mjs above.
  const m = detectSerializationAccident("mcp__claude-peers__roadmap_add", {
    title: "t",
    description: '</description>\n<parameter name="bogus_field">rest of the content',
    rationale: "r",
    context: "c",
  });
  expect(m).not.toBeNull();
  expect(m?.targetField).toBe("bogus_field");
});

test("Object.hasOwn behavior: a prototype-chain tool_name (toString) is treated as unknown and LETS THE CALL THROUGH", () => {
  // Team-lead note: test the BEHAVIOR (no decision), not the mechanism (that
  // `in` would have thrown and been caught by fail-open) -- the release
  // engineer already replaced `in` with Object.hasOwn specifically so this
  // is a real "not our tool" answer, not an accidental exception path.
  const decision = buildDecision({
    hook_event_name: "PreToolUse",
    tool_name: "toString",
    tool_input: { title: "x" },
  });
  expect(decision).toBeNull();
});

// --- Coverage cross-check: two real, independently-maintained sets agree ---

test("hooks.json's PreToolUse matcher set equals the .ts source's TOOL_TEXT_FIELDS key set", () => {
  const hooksJson = JSON.parse(readFileSync(HOOKS_JSON, "utf-8")) as {
    hooks: { PreToolUse?: Array<{ matcher: string }> };
  };
  const matcherSet = new Set((hooksJson.hooks.PreToolUse ?? []).map((e) => e.matcher));

  const src = readFileSync(HOOK_TS, "utf-8");
  const declMatch = /const TOOL_TEXT_FIELDS[^{]*\{/.exec(src);
  if (!declMatch) throw new Error("TOOL_TEXT_FIELDS declaration not found in roadmap-guard-hook.ts");
  let depth = 1;
  let i = declMatch.index + declMatch[0].length;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  const body = src.slice(declMatch.index + declMatch[0].length, i - 1);
  const toolNameSet = new Set([...body.matchAll(/"(mcp__[^"]+)"\s*:/g)].map((m) => m[1]));

  expect(toolNameSet.size).toBeGreaterThan(0);
  expect(matcherSet).toEqual(toolNameSet);
});
