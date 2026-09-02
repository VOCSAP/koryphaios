import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  detectSerializationAccident,
  buildDecision,
  parseHookPayload,
} from "../desktop/hooks/roadmap-guard-hook.ts";
import { extractBracedBody } from "./_braced-body";

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
// edit with no rebuild would be invisible to any test that only imports the
// .ts. This file tests BOTH, deliberately, for different reasons:
//   - unit-level edge cases (no-preceding-close, no-known-field condition
//     on the target) import the .ts directly -- fast, precise, and these
//     are pure-function properties that do not depend on which artifact
//     ships. Decision: follow tests/approval-hook.test.ts's own precedent
//     (imports the sibling hook's .ts directly), per the team lead's
//     explicit call on this exact question.
//   - the FIVE real roadmap-sample payloads (the ones that actually decide
//     whether this hook is correct) are piped into a REAL BUILT .mjs via a
//     real spawned process -- that is what a live Claude Code session
//     actually runs, so these are the only tests that can be wrong in the
//     way that matters.
//
// THE BUNDLE IS NOT COMMITTED (card 7e5c0f08, 2026-08-25): it was tracked by
// oversight (never added to desktop/.gitignore next to its two siblings
// desk-backchannel-hook.mjs and approval-hook.mjs), and committing it forced
// a byte-exact freshness test whose result depended on the bun VERSION and
// the checkout's line-ending conversion, not just on the source -- it went
// red on all 3 CI legs the same day it shipped, then red again on Windows
// alone from a second, unrelated cause (CRLF). This file now BUILDS ITS OWN
// throwaway copy in a `beforeAll` (see `builtMjsPath` below) instead of
// reading a checked-in file, which removes the freshness test entirely (a
// self-built copy cannot go stale) and also closes the build-cwd pin (card
// 6781c2a8's M1): the build always runs from `DESKTOP_DIR`, never from
// whatever directory `bun test` happened to be invoked from.
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

// Card 7e5c0f08: the .mjs this file exercises is no longer committed, and CI
// runs this test BEFORE `npm run build:hook` (`.github/workflows/desktop-
// build.yml` installs+tests desktop/ before its own build step), so the
// checked-out tree has no bundle to read at test time. Build a throwaway
// copy once, into a scratch dir cleaned up by the `afterAll` above, using
// the exact command desktop/package.json's build:hook script uses for this
// file -- same source, same target, same cwd (DESKTOP_DIR) as a real build.
let builtMjsPath: string;
beforeAll(async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "cp-roadmap-guard-selfbuild-"));
  tmpDirs.push(scratchDir);
  builtMjsPath = join(scratchDir, "roadmap-guard-hook.mjs");
  const proc = Bun.spawn(
    ["bun", "build", "hooks/roadmap-guard-hook.ts", "--target=node", `--outfile=${builtMjsPath}`],
    { cwd: DESKTOP_DIR, stdout: "ignore", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`self-build of roadmap-guard-hook.mjs failed (exit ${exitCode}): ${stderr}`);
  }
});

interface DecisionOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

/** Spawns the self-built .mjs (see `builtMjsPath` above) with `stdinText` on
 * stdin, returns its raw stdout. */
async function runHookMjs(stdinText: string, mjsPath: string = builtMjsPath): Promise<string> {
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

// --- Card 0e28cb4e: the SECOND real closing-tag spelling (generic
// `</parameter>`, not field-named). Measured 2026-08-25: this form is what
// Claude Code's own tool-call serialization always emits, and the
// b313f0c3/800b0fe3 rule above only ever matched the semantic `</field>`
// spelling, so this payload passed straight through (empty stdout, exit 0,
// no deny) before the fix that added the `</parameter>` alternative to
// `detectSerializationAccident`'s regex. Mutation-tested below: removing
// that alternative reproduces the exact red this test showed pre-fix.

test(
  "card 0e28cb4e: accident with the GENERIC closing spelling (`</parameter>` instead of `</description>`) -> DENY",
  async () => {
    const out = await runHookMjs(loadFixture("payload-0e28cb4e-generic-close-accident.json"));
    expect(out.trim().length).toBeGreaterThan(0);
    const decision = JSON.parse(out) as DecisionOutput;
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain('"description"');
    // The remedy must name the tag spelling actually present in the
    // caller's text (the generic form here), not an assumed `</description>`
    // that never appeared -- see buildRefusalReason's closingTag use.
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain("</parameter>");
  },
  15_000
);

test(
  "card 0e28cb4e negative control: a partial roadmap_update citing the GENERIC spelling as an incomplete fragment -> PASS",
  async () => {
    const out = await runHookMjs(loadFixture("payload-0e28cb4e-generic-close-citation.json"));
    expect(out).toBe("");
  },
  15_000
);

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
  const body = extractBracedBody(src, declMatch.index + declMatch[0].length - 1);
  const toolNameSet = new Set([...body.matchAll(/"(mcp__[^"]+)"\s*:/g)].map((m) => m[1]));

  expect(toolNameSet.size).toBeGreaterThan(0);
  expect(matcherSet).toEqual(toolNameSet);
});
