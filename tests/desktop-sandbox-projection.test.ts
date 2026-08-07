// PLAN-SANDBOX M2: operator-config projection (allow-list, sandbox-overrides
// overlay, host-only hook detection) — desktop/src/main/sandbox-projection.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECTED_ENTRIES,
  SIG_MAX_ENTRIES,
  containerSignature,
  describeProjection,
  detectHostOnlyHooks,
  parseProjectedMarker,
  planProjection,
  projectionHookWarnings,
  projectionSignature,
  signatureOfEntries,
  stripHostOnlyHooks,
  unknownOverrides,
} from "../desktop/src/main/sandbox-projection.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-sandbox-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("only allow-listed entries are projected — credentials never are", () => {
  writeFileSync(join(dir, "CLAUDE.md"), "# global");
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, ".credentials.json"), '{"token":"secret"}');
  mkdirSync(join(dir, "projects"));
  writeFileSync(join(dir, "settings.json"), "{}");

  const names = planProjection(dir).map((e) => e.name);
  expect(names.sort()).toEqual(["CLAUDE.md", "agents", "settings.json"]);
  expect(names).not.toContain(".credentials.json");
  expect(names).not.toContain("projects");
  // The allow-list is the contract: keep it explicit.
  expect(PROJECTED_ENTRIES).toContain("skills");
  expect(PROJECTED_ENTRIES).toContain("plugins");
});

test("sandbox-overrides entries win over the base copy", () => {
  writeFileSync(join(dir, "settings.json"), '{"hooks":{}}');
  writeFileSync(join(dir, "CLAUDE.md"), "base");
  mkdirSync(join(dir, "sandbox-overrides"));
  writeFileSync(join(dir, "sandbox-overrides", "settings.json"), '{"hooks":{}}');

  const entries = planProjection(dir);
  const settings = entries.find((e) => e.name === "settings.json")!;
  expect(settings.override).toBe(true);
  expect(settings.hostPath).toBe(join(dir, "sandbox-overrides", "settings.json"));
  expect(entries.find((e) => e.name === "CLAUDE.md")!.override).toBe(false);
  expect(describeProjection(entries)).toContain("settings.json (override)");
});

test("missing entries are skipped, not faked", () => {
  expect(planProjection(dir)).toEqual([]);
  expect(describeProjection([])).toBe("none");
  expect(planProjection(join(dir, "does-not-exist"))).toEqual([]);
});

test("detectHostOnlyHooks flags PowerShell / drive-letter / .ps1 commands", () => {
  const settings = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "powershell -File C:\\tools\\hook.ps1" }] },
        { hooks: [{ type: "command", command: "bun run hook.ts" }] }
      ],
      Stop: [{ hooks: [{ type: "command", command: "D:/scripts/notify.bat" }] }]
    }
  });
  const found = detectHostOnlyHooks(settings);
  expect(found.length).toBe(2);
  expect(found.some((f) => f.includes("powershell"))).toBe(true);
  expect(found.some((f) => f.includes("notify.bat"))).toBe(true);
  expect(found.some((f) => f.includes("bun run"))).toBe(false);
});

test("detectHostOnlyHooks tolerates malformed settings", () => {
  expect(detectHostOnlyHooks("{not json")).toEqual([]);
  expect(detectHostOnlyHooks("{}")).toEqual([]);
});

test("projectionHookWarnings reads the projected settings.json", () => {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "pwsh -c x" }] }] } })
  );
  expect(projectionHookWarnings(planProjection(dir))).toEqual(["pwsh -c x"]);
  expect(projectionHookWarnings([])).toEqual([]);
});

test("unknownOverrides surfaces overlay files that would silently do nothing", () => {
  mkdirSync(join(dir, "sandbox-overrides"));
  writeFileSync(join(dir, "sandbox-overrides", "settings.json"), "{}");
  writeFileSync(join(dir, "sandbox-overrides", "notes.md"), "x");
  expect(unknownOverrides(dir)).toEqual(["notes.md"]);
  expect(unknownOverrides(join(dir, "nope"))).toEqual([]);
});

test("a hook containing a URL is not flagged host-only (review finding #9)", () => {
  // `[A-Za-z]:[\\/]` unanchored also matches the `s:/` inside `https://`, so
  // every hook with a URL was reported as un-runnable in the container.
  expect(detectHostOnlyHooks(JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: "curl -s https://example.com/notify" }] }] }
  }))).toEqual([]);
  // A genuine Windows path is still caught.
  expect(detectHostOnlyHooks(JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: "node C:/tools/hook.js" }] }] }
  }))).toHaveLength(1);
});

test("detectHostOnlyHooks flags Windows-only env vars, not strftime tokens", () => {
  // The real-world shape that shipped unreported: a bash command that LOOKS
  // Linux-runnable but expands $USERPROFILE (empty in the container) into
  // `/.claude/…` and fails on every session start.
  for (const command of [
    'bash "$USERPROFILE/.claude/hooks/session-start-kleos.sh"',
    'bash "${USERPROFILE}/.claude/hooks/x.sh"',
    "echo %APPDATA%",
    '"$USERPROFILE/.cargo/bin/kleos-sh.exe" --claude-hook'
  ]) {
    expect(
      detectHostOnlyHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ command }] }] } }))
    ).toHaveLength(1);
  }
  // `%s%N` in an innocent date format must NOT trip the %VAR% branch (named
  // list, not a generic %\w+%), and a LONGER var sharing the prefix must not
  // match on its $USERPROFILE substring.
  for (const command of [
    "date +%s%N >> /tmp/trace",
    'bash "$USERPROFILE_BACKUP/hooks/x.sh"'
  ]) {
    expect(
      detectHostOnlyHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ command }] }] } }))
    ).toEqual([]);
  }
});

// The overlay generator (50ac8683): host settings minus host-only hooks.
// Removal, not translation — a translated hook whose host-side dependency is
// missing in the container would BLOCK the sandboxed agent's edits instead of
// failing non-blocking at session start.
test("stripHostOnlyHooks removes host-only hooks and empty events, keeps the rest", () => {
  const settings = {
    model: "opus",
    permissions: { allow: ["Bash(git *)"] },
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'bash "$USERPROFILE/.claude/hooks/kleos.sh"' }] }
      ],
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [
            { type: "command", command: "powershell.exe -File guard.ps1" },
            { type: "command", command: "date +%s%N >> /tmp/trace" }
          ]
        }
      ]
    }
  };
  const res = stripHostOnlyHooks(JSON.stringify(settings));
  expect(res).not.toBeNull();
  expect(res!.removed).toEqual([
    'bash "$USERPROFILE/.claude/hooks/kleos.sh"',
    "powershell.exe -File guard.ps1"
  ]);
  const out = res!.settings as {
    model: string;
    permissions: unknown;
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  // Non-hook config travels untouched.
  expect(out.model).toBe("opus");
  expect(out.permissions).toEqual({ allow: ["Bash(git *)"] });
  // The emptied SessionStart event is gone; the Linux-safe hook survives with
  // its group metadata (matcher) intact.
  expect(out.hooks.SessionStart).toBeUndefined();
  expect(out.hooks.PreToolUse).toEqual([
    { matcher: ".*", hooks: [{ type: "command", command: "date +%s%N >> /tmp/trace" }] }
  ] as never);
});

test("stripHostOnlyHooks drops the hooks key entirely when nothing survives", () => {
  const res = stripHostOnlyHooks(
    JSON.stringify({
      env: { FOO: "bar" },
      hooks: { Stop: [{ hooks: [{ command: "C:/tools/hook.exe" }] }] }
    })
  );
  expect(res!.removed).toHaveLength(1);
  expect((res!.settings as { hooks?: unknown }).hooks).toBeUndefined();
  expect((res!.settings as { env: unknown }).env).toEqual({ FOO: "bar" });
});

test("stripHostOnlyHooks returns null on non-JSON input (caller must write nothing)", () => {
  expect(stripHostOnlyHooks("{ not json")).toBeNull();
  expect(stripHostOnlyHooks('"a bare string"')).toBeNull();
});

// The projection is one `docker cp` per entry and sits on the agent-spawn
// path, where it cost the operator ~15 silent seconds per new agent. It is now
// skipped while this signature is unchanged -- so the signature has to move on
// a DEEP edit, or the skip would silently ignore a change to the global config.
test("the projection signature moves on any change, deep ones included", () => {
  mkdirSync(join(dir, "skills", "deep"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "# global");
  writeFileSync(join(dir, "skills", "deep", "SKILL.md"), "one");

  const base = projectionSignature(dir);
  expect(base).toBe(projectionSignature(dir)); // stable when nothing moves

  writeFileSync(join(dir, "skills", "deep", "SKILL.md"), "two!");
  const afterDeepEdit = projectionSignature(dir);
  expect(afterDeepEdit).not.toBe(base);

  writeFileSync(join(dir, "skills", "deep", "OTHER.md"), "new file");
  expect(projectionSignature(dir)).not.toBe(afterDeepEdit);

  // An entry that is not projected at all must not perturb it.
  const stable = projectionSignature(dir);
  writeFileSync(join(dir, ".credentials.json"), '{"token":"secret"}');
  expect(projectionSignature(dir)).toBe(stable);
});

// Card a79c7696 volet 1: deck-plugin lives under a DIFFERENT root than
// claudeHomeDir (the app's own resources dir, not the operator's ~/.claude),
// so it cannot ride planProjection(claudeHomeDir) -- signatureOfEntries is
// what lets sandbox-service fold its own ProjectionEntry into the SAME
// signature ensure() already gates a re-project on. This proves the fold
// actually moves the signature on a deck-plugin-only change, with the
// claudeHomeDir side held constant -- not just that signatureOfEntries exists.
test("signatureOfEntries folds an entry from a root outside claudeHomeDir, and moves when it changes", () => {
  writeFileSync(join(dir, "CLAUDE.md"), "# global");
  const pluginDir = mkdtempSync(join(tmpdir(), "cp-sandbox-plugin-"));
  try {
    writeFileSync(join(pluginDir, "SKILL.md"), "one");
    const withoutPlugin = signatureOfEntries(planProjection(dir));
    const withPlugin = signatureOfEntries([
      ...planProjection(dir),
      { name: "deck-plugin", hostPath: pluginDir, override: false },
    ]);
    expect(withPlugin).not.toBe(withoutPlugin);
    expect(withPlugin).toContain("deck-plugin");

    writeFileSync(join(pluginDir, "SKILL.md"), "two!");
    const afterEdit = signatureOfEntries([
      ...planProjection(dir),
      { name: "deck-plugin", hostPath: pluginDir, override: false },
    ]);
    expect(afterEdit).not.toBe(withPlugin);
    // claudeHomeDir side alone is unaffected by the deck-plugin edit.
    expect(signatureOfEntries(planProjection(dir))).toBe(withoutPlugin);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

// Reviewer measured (card a79c7696 volet 1 review, correction 1): the test
// above bites on a 3-file fixture, far under SIG_MAX_ENTRIES's shared
// per-walk budget -- it proves the FEATURE works, not that it survives the
// real domain. signatureOfEntries decrements ONE budget across the entries
// it walks IN ARRAY ORDER, so concatenating [...operatorEntries,
// deckPluginEntry] into a SINGLE walk starves deck-plugin's fingerprint to
// zero once the operator config alone exceeds the budget (an installed
// plugin with deps reaches SIG_MAX_ENTRIES files without effort) -- a
// deck-plugin-only edit then silently stops moving the signature. This
// builds an operator config that genuinely exceeds SIG_MAX_ENTRIES and
// proves BOTH halves: the single-walk composition really is blind past the
// budget (red without the fix), and two INDEPENDENT walks concatenated as
// strings (order no longer able to matter) is not.
test("a deck-plugin-only edit still moves the signature when the operator config exceeds SIG_MAX_ENTRIES", () => {
  const bigDir = mkdtempSync(join(tmpdir(), "cp-sandbox-big-"));
  const pluginDir = mkdtempSync(join(tmpdir(), "cp-sandbox-plugin2-"));
  try {
    const agentsDir = join(bigDir, "agents");
    mkdirSync(agentsDir);
    const fileCount = SIG_MAX_ENTRIES + 200;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(agentsDir, `a${i}.md`), "x");
    }
    writeFileSync(join(pluginDir, "SKILL.md"), "one");

    const operatorEntries = planProjection(bigDir);
    const deckPluginEntry = { name: "deck-plugin", hostPath: pluginDir, override: false };

    // The composition the review flagged: deck-plugin concatenated INTO the
    // operator walk, sharing its budget, LAST in array order.
    const singleWalkBefore = signatureOfEntries([...operatorEntries, deckPluginEntry]);
    writeFileSync(join(pluginDir, "SKILL.md"), "two!");
    const singleWalkAfter = signatureOfEntries([...operatorEntries, deckPluginEntry]);
    // Documents the DEFECT this fixes -- starved, does not move. Not an
    // invariant to preserve: if a future budgeting change makes the single
    // walk survive this fixture too, this specific assertion should be
    // deleted, not "fixed" (the value assertion below is what matters).
    expect(singleWalkBefore).toBe(singleWalkAfter);

    // The fix, exercised THROUGH production (card a79c7696 volet 1 review,
    // 2nd pass): call sandbox-service.ts's actual composition function
    // (containerSignature) instead of re-typing its shape here -- a
    // re-implementation only proves its own copy stays correct if ensure()'s
    // logic changes underneath it, not that production calls this path.
    writeFileSync(join(pluginDir, "SKILL.md"), "one"); // reset to the pre-edit content
    const fixedBefore = containerSignature("fake-container-id", [deckPluginEntry], bigDir, true);
    writeFileSync(join(pluginDir, "SKILL.md"), "two!");
    const fixedAfter = containerSignature("fake-container-id", [deckPluginEntry], bigDir, true);
    expect(fixedBefore).not.toBe(fixedAfter);
  } finally {
    rmSync(bigDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  }
}, 30_000);

test("a symlinked entry is followed, and a dangling one is simply absent", () => {
  // Operators commonly keep ~/.claude entries as links into a config repo --
  // which is why the projection copies with `docker cp -L`. The signature must
  // read through the link the same way, and must not throw on a broken one
  // (planProjection's existsSync follows too, so it drops out of the plan).
  writeFileSync(join(dir, "CLAUDE.md"), "# global");
  const real = join(dir, "elsewhere.md");
  writeFileSync(real, "linked content");
  try {
    symlinkSync(real, join(dir, "settings.json"));
    symlinkSync(join(dir, "nowhere"), join(dir, "agents"));
  } catch {
    return; // symlink creation needs privileges on some Windows setups
  }
  const sig = projectionSignature(dir);
  expect(sig).toContain("settings.json"); // followed, not recorded as a link
  expect(sig).not.toContain("agents"); // dangling: dropped by the plan
  expect(() => projectionSignature(dir)).not.toThrow();
});

// ----- projection marker (key + persisted summary) -----

test("parseProjectedMarker round-trips JSON and falls back on legacy plain markers", () => {
  const json = JSON.stringify({
    key: "abc\nsig",
    summary: "CLAUDE.md, settings.json (overlay)",
    hookWarnings: ["powershell -File check.ps1"],
  });
  expect(parseProjectedMarker(json)).toEqual({
    key: "abc\nsig",
    summary: "CLAUDE.md, settings.json (overlay)",
    hookWarnings: ["powershell -File check.ps1"],
  });
  // Pre-JSON marker (a raw signature string): the whole content is the key,
  // so existing containers keep SKIPPING re-projection after the upgrade.
  expect(parseProjectedMarker("abc\nsig")).toEqual({ key: "abc\nsig", summary: null, hookWarnings: [] });
  // Disabled-scrub marker: summary stays null (nothing is in the container).
  expect(parseProjectedMarker(JSON.stringify({ key: "abc\ndisabled", summary: null }))).toEqual({
    key: "abc\ndisabled",
    summary: null,
    hookWarnings: [],
  });
  // Garbage fields are clamped, never thrown on.
  expect(parseProjectedMarker(JSON.stringify({ key: "k", summary: 42, hookWarnings: [1, "ok"] }))).toEqual({
    key: "k",
    summary: null,
    hookWarnings: ["ok"],
  });
  // JSON that is not a marker (no string key) is treated as a legacy key too.
  expect(parseProjectedMarker("[1,2]").key).toBe("[1,2]");
});
