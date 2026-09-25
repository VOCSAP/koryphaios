import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node-only modules (no electron / no @shared alias), import under bun.
import {
  FIELD_CAP,
  MAX_FILE_BYTES,
  MAX_HOOK_TEXT_CHARS,
  MAX_RULES,
  buildHookOutput,
  evaluate,
  extractField,
  hasNestedQuantifier,
  globToRegExp,
  parseEffectiveFile,
  parseRulesFile,
  qualifyRule,
  rulesHash,
  type TtsrEffectiveRule,
  type TtsrResult,
  type TtsrRule,
} from "../desktop/src/shared/ttsr-rules";
import { KORY_EFFECTIVE_RULES, KORY_RULES } from "../desktop/src/shared/ttsr-builtin";

const base = (): Record<string, unknown> => ({
  id: "no-foo",
  event: "PreToolUse",
  tools: ["Edit", "Write"],
  field: "added",
  pattern: "foo",
  mode: "deny",
  message: "Do not write foo: write bar instead.",
});

const fileOf = (rules: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, rules, ...extra });

function errorsOf(text: string): string[] {
  const res = parseRulesFile(text);
  if (res.ok) throw new Error("expected the file to be rejected");
  return res.errors;
}

function expectRejected(r: Record<string, unknown>, fragment: string): void {
  const errors = errorsOf(fileOf([r]));
  expect(errors.join("\n")).toContain(fragment);
}

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("parseRulesFile: accepts", () => {
  test("a valid file with every field", () => {
    const res = parseRulesFile(
      fileOf([{ ...base(), paths: ["desktop/src/renderer/**", "!**/*.test.ts"], flags: "iu" }]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.file.rules[0]!.paths).toEqual(["desktop/src/renderer/**", "!**/*.test.ts"]);
  });

  test("a PostToolUse warn on Bash output", () => {
    const res = parseRulesFile(
      fileOf([{ ...base(), event: "PostToolUse", tools: ["Bash"], field: "output", mode: "warn" }]),
    );
    expect(res.ok).toBe(true);
  });
});

describe("parseRulesFile: one case per rejection", () => {
  test("invalid JSON", () => expect(errorsOf("{").join()).toContain("invalid JSON"));
  test("not an object", () => expect(errorsOf("[]").join()).toContain("must be a JSON object"));
  test("wrong version", () => expect(errorsOf(JSON.stringify({ version: 2, rules: [] })).join()).toContain("version"));
  test("rules not an array", () =>
    expect(errorsOf(JSON.stringify({ version: 1, rules: {} })).join()).toContain("rules: must be an array"));
  test("unknown file-level field", () =>
    expect(errorsOf(fileOf([base()], { rule: [] })).join()).toContain("file: rule: unknown field"));
  test("more than MAX_RULES rules", () => {
    const rules = Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ ...base(), id: `r-${i}` }));
    expect(errorsOf(fileOf(rules)).join()).toContain("exceed the limit");
  });
  test("file larger than 64 KiB", () => {
    const text = fileOf([base()]) + " ".repeat(MAX_FILE_BYTES);
    expect(errorsOf(text).join()).toContain("byte limit");
  });
  test("rule not an object", () => expect(errorsOf(fileOf(["x"])).join()).toContain("rules[0]: must be an object"));
  test("unknown rule field (typo)", () => {
    const r = base();
    r.patern = r.pattern;
    expectRejected(r, 'rules[0] "no-foo": patern: unknown field');
  });
  test("__proto__ key is an unknown field", () => {
    const text = fileOf([base()]).replace('"id"', '"__proto__":{},"id"');
    expect(errorsOf(text).join()).toContain("__proto__: unknown field");
  });
  test("id not kebab-case", () => expectRejected({ ...base(), id: "No_Foo" }, "kebab-case"));
  test("id too long", () => expectRejected({ ...base(), id: "a".repeat(65) }, "at most 64"));
  test("duplicate id", () => {
    const errors = errorsOf(fileOf([base(), base()]));
    expect(errors.join()).toContain('rules[1] "no-foo": id: duplicates rules[0]');
  });
  test("bad event", () => expectRejected({ ...base(), event: "Stop" }, "event: must be one of"));
  test("empty tools", () => expectRejected({ ...base(), tools: [] }, "tools: must be a non-empty array"));
  test("unknown tool", () => expectRejected({ ...base(), tools: ["Read"] }, '"Read" is not one of'));
  test("repeated tool", () => expectRejected({ ...base(), tools: ["Edit", "Edit"] }, '"Edit" is repeated'));
  test("bad field", () => expectRejected({ ...base(), field: "content" }, "field: must be one of"));
  test("bad mode", () => expectRejected({ ...base(), mode: "block" }, "mode: must be one of"));
  test("added on Bash", () => expectRejected({ ...base(), tools: ["Bash"] }, '"added" does not apply to tool Bash'));
  test("command on Edit", () => expectRejected({ ...base(), field: "command" }, '"command" does not apply to tool Edit'));
  test("file_path on Bash", () =>
    expectRejected({ ...base(), field: "file_path", tools: ["Bash"] }, '"file_path" does not apply to tool Bash'));
  test("output on PreToolUse", () =>
    expectRejected({ ...base(), field: "output", tools: ["Bash"], mode: "warn" }, '"output" is only available on PostToolUse'));
  test("PostToolUse on a non-Bash tool", () =>
    expectRejected({ ...base(), event: "PostToolUse", mode: "warn" }, "PostToolUse rules support only Bash"));
  test("deny on PostToolUse", () =>
    expectRejected({ ...base(), event: "PostToolUse", tools: ["Bash"], field: "output" }, "deny is not allowed on PostToolUse"));
  test("pattern missing", () => expectRejected({ ...base(), pattern: "" }, "pattern: must be a non-empty string"));
  test("pattern does not compile", () => expectRejected({ ...base(), pattern: "(foo" }, "does not compile"));
  test("pattern does not compile under its flags", () =>
    expectRejected({ ...base(), pattern: "\\p{NoSuchProperty}", flags: "u" }, "does not compile"));
  test("pattern matches the empty string", () => expectRejected({ ...base(), pattern: "x*" }, "matches the empty string"));
  for (const p of ["(a+)+", "(\\w*)*", "(x+)*", "(?:ab+c){2,}", "((a+)b)+"]) {
    test(`nested quantifier ${p}`, () => expectRejected({ ...base(), pattern: p }, "nested unbounded quantifier"));
  }
  test("disallowed flag", () => expectRejected({ ...base(), flags: "g" }, 'flag "g" is not allowed'));
  test("duplicate flag", () => expectRejected({ ...base(), flags: "ii" }, 'flag "i" is repeated'));
  test("flags not a string", () => expectRejected({ ...base(), flags: 1 }, "flags: must be a string"));
  test("paths empty array", () => expectRejected({ ...base(), paths: [] }, "paths: must be a non-empty array"));
  test("paths non-string", () => expectRejected({ ...base(), paths: [3] }, "paths[0]: must be a string"));
  test("paths with ..", () => expectRejected({ ...base(), paths: ["src/../etc/**"] }, '".." segment'));
  test("paths posix absolute", () => expectRejected({ ...base(), paths: ["/etc/**"] }, "not absolute"));
  test("paths Windows drive", () => expectRejected({ ...base(), paths: ["C:/Users/**"] }, "not a drive path"));
  test("paths UNC", () => expectRejected({ ...base(), paths: ["\\\\server\\share"] }, '"/" separators'));
  test("paths unsupported syntax", () => expectRejected({ ...base(), paths: ["src/*.{ts,tsx}"] }, "unsupported glob syntax"));
  test("paths trailing slash", () => expectRejected({ ...base(), paths: ["desktop/"] }, "empty segment"));
  test("paths ** inside a segment", () => expectRejected({ ...base(), paths: ["src/a**"] }, "whole segment"));
  test("message empty", () => expectRejected({ ...base(), message: "  " }, "message: must be a non-empty string"));
  test("message too long", () => expectRejected({ ...base(), message: "x".repeat(401) }, "at most 400"));

  test("collects every error, each naming the rule and the field", () => {
    const errors = errorsOf(fileOf([{ ...base(), mode: "nope" }, { ...base(), id: "two", pattern: "(" , message: "" }]));
    expect(errors).toContain('rules[0] "no-foo": mode: must be one of deny, warn');
    expect(errors.some((e) => e.startsWith('rules[1] "two": pattern:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('rules[1] "two": message:'))).toBe(true);
  });

  test("an invalid rule rejects the whole file, never a subset", () => {
    const res = parseRulesFile(fileOf([base(), { ...base(), id: "bad", mode: "x" }]));
    expect(res.ok).toBe(false);
    expect("file" in res).toBe(false);
  });
});

describe("hasNestedQuantifier heuristic", () => {
  test("accepts bounded and non-nested groups", () => {
    for (const p of ["(ab)+", "(a+)?", "(a+){1,3}", "[(a+)]+", "\\(a+\\)+", "\\p{L}+"]) {
      expect(hasNestedQuantifier(p)).toBe(false);
    }
  });
});

describe("parseEffectiveFile", () => {
  const eff = (r: TtsrRule, source = "repo"): Record<string, unknown> => ({ ...r, source, qualifiedId: `${source}/${r.id}` });

  test("accepts the same id from two sources", () => {
    const r = base() as unknown as TtsrRule;
    const res = parseEffectiveFile(fileOf([eff(r, "repo"), eff(r, "user")]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.file.rules.map((x) => x.qualifiedId)).toEqual(["repo/no-foo", "user/no-foo"]);
  });

  test("rejects a qualifiedId that does not match source/id", () => {
    const res = parseEffectiveFile(fileOf([{ ...eff(base() as unknown as TtsrRule), qualifiedId: "kory/no-foo" }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('qualifiedId: must be "repo/no-foo"');
  });

  test("rejects an unknown source and a duplicated qualifiedId", () => {
    const r = base() as unknown as TtsrRule;
    const res = parseEffectiveFile(fileOf([eff(r, "evil"), eff(r), eff(r)]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.join()).toContain("source: must be one of kory, user, repo");
      expect(res.errors.join()).toContain("qualifiedId: duplicates rules[1]");
    }
  });

  test("re-runs the per-rule validator (empty-match pattern rejected)", () => {
    const res = parseEffectiveFile(fileOf([{ ...eff(base() as unknown as TtsrRule), pattern: "a?" }]));
    expect(res.ok).toBe(false);
  });

  test("round-trips the built-ins", () => {
    const res = parseEffectiveFile(JSON.stringify({ version: 1, rules: KORY_EFFECTIVE_RULES }));
    expect(res.ok).toBe(true);
  });
});

test("rulesHash is sha256 hex of the UTF-8 bytes", () => {
  expect(rulesHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(rulesHash("é")).not.toBe(rulesHash("e"));
});

describe("extractField", () => {
  test("added per tool, including every MultiEdit edit", () => {
    expect(extractField({ tool_name: "Edit", tool_input: { new_string: "a", old_string: "z" } }, "added")).toEqual(["a"]);
    expect(
      extractField(
        { tool_name: "MultiEdit", tool_input: { edits: [{ new_string: "one" }, { new_string: "two" }, { old_string: "x" }] } },
        "added",
      ),
    ).toEqual(["one", "two"]);
    expect(extractField({ tool_name: "Write", tool_input: { content: "c" } }, "added")).toEqual(["c"]);
    expect(extractField({ tool_name: "NotebookEdit", tool_input: { new_source: "n" } }, "added")).toEqual(["n"]);
    expect(extractField({ tool_name: "Bash", tool_input: { command: "ls" } }, "added")).toEqual([]);
  });

  test("command, file_path (incl. notebook_path) and output", () => {
    expect(extractField({ tool_name: "Bash", tool_input: { command: "ls" } }, "command")).toEqual(["ls"]);
    expect(extractField({ tool_name: "Edit", tool_input: { file_path: "/p/a.ts" } }, "file_path")).toEqual(["/p/a.ts"]);
    expect(extractField({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/p/n.ipynb" } }, "file_path")).toEqual([
      "/p/n.ipynb",
    ]);
    expect(
      extractField({ tool_name: "Bash", tool_input: {}, tool_response: { stdout: "out", stderr: "err" } }, "output"),
    ).toEqual(["out", "err"]);
  });

  test("each string is capped at FIELD_CAP", () => {
    const [s] = extractField({ tool_name: "Write", tool_input: { content: "x".repeat(FIELD_CAP + 10) } }, "added");
    expect(s!.length).toBe(FIELD_CAP);
  });

  test("hostile shapes yield nothing", () => {
    expect(extractField(null, "added")).toEqual([]);
    expect(extractField({ tool_name: "MultiEdit", tool_input: { edits: "x" } }, "added")).toEqual([]);
    expect(extractField({ tool_name: "Edit", tool_input: { new_string: 42 } }, "added")).toEqual([]);
  });
});

function pre(tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...extra };
}

function firesKory(id: string, payload: Record<string, unknown>): boolean {
  const res = evaluate(KORY_EFFECTIVE_RULES, payload, process.cwd());
  return [...res.denies, ...res.warns].some((m) => m.qualifiedId === `kory/${id}`);
}

describe("built-in Kory rules", () => {
  test("every built-in passes the file validator", () => {
    const res = parseRulesFile(JSON.stringify({ version: 1, rules: KORY_RULES }));
    if (!res.ok) throw new Error(`built-in rules must validate: ${res.errors.join("; ")}`);
    expect(KORY_RULES.map((r) => r.id).sort()).toEqual(
      ["control-byte", "empty-catch", "git-add-all", "git-force-push", "git-no-verify", "secret-literal"],
    );
    expect(KORY_EFFECTIVE_RULES.every((r) => r.source === "kory" && r.qualifiedId === `kory/${r.id}`)).toBe(true);
  });

  const write = (content: string): Record<string, unknown> => pre("Write", { file_path: "/x/a.ts", content });
  const bash = (command: string): Record<string, unknown> => pre("Bash", { command });

  const cases: Array<[string, Record<string, unknown>[], Record<string, unknown>[]]> = [
    [
      "empty-catch",
      [write("try { x() } catch {}"), write("try { x() } catch (e) { }"), write("p.catch(() => {})"), write("p.catch((err) => { })")],
      [write("try { x() } catch (e) { log(e) }"), write("p.catch((e) => report(e))")],
    ],
    ["control-byte", [write("a\x1b[0m"), write("nul\x00"), write("bell\x07")], [write("a\\x1b[0m"), write("tab\tnewline\n")]],
    [
      "git-add-all",
      [bash("git add -A"), bash("git add ."), bash("git add --all && git commit"), bash("git -C repo add -v .")],
      [bash("git add src/a.ts"), bash("git add ./src/a.ts"), bash("git add -p")],
    ],
    [
      "git-no-verify",
      [bash("git commit --no-verify -m x"), bash("git push --no-verify")],
      [bash("git commit -m 'verify'"), bash("grep no-verify-foo x")],
    ],
    [
      "git-force-push",
      [bash("git push --force"), bash("git push -f origin main"), bash("git push origin +main"), bash("git push -uf origin x")],
      [
        bash("git push --force-with-lease"),
        bash("git push --force-with-lease=main:abc origin main"),
        bash("git push -u origin feat-f"),
        bash("git push --follow-tags"),
        bash("git push && rm -f x"),
      ],
    ],
    [
      "secret-literal",
      [
        write(`const k = "${"sk-" + "ant-"}api03-abcdefghijkl"`),
        write(`t = ${"gh" + "p_"}${"a".repeat(36)}`),
        write(`id = ${"AK" + "IA"}IOSFODNN7EXAMPLE`),
        write(`${"-----BEGIN " + "RSA PRIVATE"} KEY-----`),
      ],
      [write("const k = process.env.ANTHROPIC_API_KEY"), write("-----BEGIN PUBLIC KEY-----")],
    ],
  ];

  for (const [id, positives, negatives] of cases) {
    test(`${id}: fires on positives, silent on negatives`, () => {
      for (const p of positives) expect({ id, input: p.tool_input, fired: firesKory(id, p) }).toMatchObject({ fired: true });
      for (const p of negatives) expect({ id, input: p.tool_input, fired: firesKory(id, p) }).toMatchObject({ fired: false });
    });
  }

  test("built-ins apply to MultiEdit: any one edit triggers", () => {
    const p = pre("MultiEdit", { file_path: "/x/a.ts", edits: [{ new_string: "ok" }, { new_string: "catch {}" }] });
    expect(firesKory("empty-catch", p)).toBe(true);
  });
});

describe("evaluate", () => {
  const rule = (over: Partial<TtsrRule>, source: "repo" | "user" = "repo"): TtsrEffectiveRule =>
    qualifyRule(source, { ...(base() as unknown as TtsrRule), ...over });

  test("filters on event and tool", () => {
    const r = rule({ tools: ["Edit"] });
    expect(evaluate([r], pre("Write", { content: "foo" }), "/").denies).toHaveLength(0);
    expect(evaluate([r], { ...pre("Edit", { new_string: "foo" }), hook_event_name: "PostToolUse" }, "/").denies).toHaveLength(0);
    expect(evaluate([r], pre("Edit", { new_string: "foo" }), "/").denies).toHaveLength(1);
  });

  test("PostToolUse Bash output warn", () => {
    const r = rule({ event: "PostToolUse", tools: ["Bash"], field: "output", mode: "warn", pattern: "FAILED" });
    const res = evaluate([r], { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: { stdout: "", stderr: "3 FAILED" } }, "/");
    expect(res.warns.map((m) => m.qualifiedId)).toEqual(["repo/no-foo"]);
  });

  test("paths filter, relative to the project, with ! exclusion", () => {
    const root = mkdtempSync(join(tmpdir(), "ttsr-paths-"));
    tmpRoots.push(root);
    const r = rule({ paths: ["desktop/src/renderer/**", "!**/*.test.ts"] });
    const at = (rel: string) => evaluate([r], pre("Write", { file_path: join(root, rel), content: "foo" }), root).denies.length;
    expect(at("desktop/src/renderer/a/b.tsx")).toBe(1);
    expect(at("desktop/src/renderer/b.test.ts")).toBe(0);
    expect(at("desktop/src/main/b.ts")).toBe(0);
    expect(evaluate([r], pre("Write", { file_path: join(tmpdir(), "elsewhere.ts"), content: "foo" }), root).denies).toHaveLength(0);
    expect(evaluate([r], pre("Write", { content: "foo" }), root).denies).toHaveLength(0);
  });

  test("Bash rules with paths filter on the session cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "ttsr-cwd-"));
    tmpRoots.push(root);
    mkdirSync(join(root, "desktop", "src"), { recursive: true });
    const r = rule({ tools: ["Bash"], field: "command", pattern: "^npm\\b", paths: ["!desktop/**"] });
    const run = (cwd: string | undefined) =>
      evaluate([r], pre("Bash", { command: "npm test" }, cwd === undefined ? {} : { cwd }), root).denies.length;
    expect(run(root)).toBe(1);
    expect(run(join(root, "desktop"))).toBe(0);
    expect(run(join(root, "desktop", "src"))).toBe(0);
    expect(run(undefined)).toBe(0);
  });

  test("paths survive a symlinked project prefix (both sides canonicalized)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ttsr-link-"));
    tmpRoots.push(tmp);
    const real = join(tmp, "real");
    mkdirSync(join(real, "proj", "desktop", "src", "renderer"), { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link, "junction");
    const r = rule({ paths: ["desktop/src/renderer/**"] });
    // Project reached through the link, file reported through the real path, and
    // the reverse; the target does not exist yet (a Write creating it).
    const viaLinkRoot = evaluate(
      [r],
      pre("Write", { file_path: join(real, "proj", "desktop", "src", "renderer", "new.tsx"), content: "foo" }),
      join(link, "proj"),
    );
    const viaLinkFile = evaluate(
      [r],
      pre("Write", { file_path: join(link, "proj", "desktop", "src", "renderer", "new", "deep.tsx"), content: "foo" }),
      join(real, "proj"),
    );
    expect(viaLinkRoot.denies).toHaveLength(1);
    expect(viaLinkFile.denies).toHaveLength(1);
  });

  test("glob translation", () => {
    expect(globToRegExp("**").test("")).toBe(true);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("docs/a.md")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/b")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/x/y/b")).toBe(true);
    expect(globToRegExp("desktop/**").test("desktop")).toBe(true);
    expect(globToRegExp("desktop/**").test("desktopx")).toBe(false);
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a.ts").test("abts")).toBe(false);
  });
});

describe("buildHookOutput", () => {
  const m = (id: string, mode: "deny" | "warn") => ({ qualifiedId: id, mode, message: `msg ${id}` });

  test("no match, no output", () => {
    expect(buildHookOutput("PreToolUse", { denies: [], warns: [] })).toBeNull();
  });

  test("deny wins over warn and carries only the deny messages, prefixed", () => {
    const out = buildHookOutput("PreToolUse", { denies: [m("repo/a", "deny")], warns: [m("user/b", "warn")] });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[repo/a] msg repo/a" },
    });
  });

  test("warn only yields additionalContext", () => {
    const out = buildHookOutput("PreToolUse", { denies: [], warns: [m("repo/no-emoji-ui", "warn"), m("kory/x", "warn")] });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "[repo/no-emoji-ui] msg repo/no-emoji-ui\n[kory/x] msg kory/x" },
    });
  });

  test("text is capped", () => {
    const warns = Array.from({ length: 50 }, (_, i) => ({ qualifiedId: `repo/r-${i}`, mode: "warn" as const, message: "y".repeat(390) }));
    const out = buildHookOutput("PreToolUse", { denies: [], warns });
    const text = (out!.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(text.length).toBeLessThanOrEqual(MAX_HOOK_TEXT_CHARS + 40);
    expect(text).toContain("more rule(s) matched");
  });

  test("never emits allow or ask: that would skip or alter the operator's permission prompt", () => {
    const shapes: TtsrResult[] = [
      { denies: [], warns: [] },
      { denies: [], warns: [m("repo/w", "warn")] },
      { denies: [m("repo/d", "deny")], warns: [] },
      { denies: [m("repo/d", "deny")], warns: [m("repo/w", "warn")] },
    ];
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      for (const r of shapes) {
        const out = buildHookOutput(event, r);
        const decision = out ? (out.hookSpecificOutput as Record<string, unknown>).permissionDecision : undefined;
        if (decision !== undefined && decision !== "deny") {
          throw new Error(
            `buildHookOutput emitted permissionDecision "${String(decision)}" for ${event}: only "deny" is allowed, ` +
              `"allow" or "ask" would bypass or alter the operator's permission prompt`,
          );
        }
        if (event === "PostToolUse" && decision !== undefined) {
          throw new Error("buildHookOutput emitted a permissionDecision on PostToolUse, where it has no meaning");
        }
        if (r.denies.length === 0 && decision !== undefined) {
          throw new Error("a warn-only result emitted a permissionDecision: warns must never touch the operator's permission prompt");
        }
      }
    }
  });

  test("PostToolUse folds a deny match into context", () => {
    const out = buildHookOutput("PostToolUse", { denies: [m("repo/d", "deny")], warns: [] });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "[repo/d] msg repo/d" } });
  });
});
