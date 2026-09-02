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

// Matches a field's own closing tag immediately followed by another parameter's
// opening tag, with no condition on that other field's name or type.
// A condition requiring the other field to be a known, empty text field was
// tried and rejected: it exempted accidents naming a non-text field and made
// the roadmap_append_context matcher permanently unable to fire, since its one
// field can never swallow itself.

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

// Builds a throwaway copy of the compiled hook in beforeAll rather than reading
// a checked-in file: the bundle isn't committed, and comparing against one
// would tie the test's freshness to the build environment rather than the
// source.
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

// Matches the generic `</parameter>` closing spelling in addition to the
// field-named one, since that is what real tool-call serialization always emits
// and a rule matching only the semantic spelling lets it through undetected.

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
