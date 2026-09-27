import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Node-only modules (no electron / no @shared alias), import under bun.
import {
  COMMAND_CAP,
  FIELD_CAP,
  MAX_FILE_BYTES,
  MAX_HOOK_TEXT_CHARS,
  MAX_RULES,
  buildHookOutput,
  evaluate,
  extractField,
  hasNestedQuantifier,
  hookEvaluationOrder,
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
  for (const p of ["a", "\\s", "\\d", "_", "\\n", "[a-z]", "x"])
    test(`pattern ${p} matching trivial text`, () => expectRejected({ ...base(), pattern: p }, "matches the trivial text"));
  test("\\p{...} without the u flag", () => {
    expectRejected({ ...base(), pattern: "\\p{Extended_Pictographic}" }, 'without the "u" flag');
    expectRejected({ ...base(), pattern: "x\\P{L}" }, 'without the "u" flag');
    expect(parseRulesFile(fileOf([{ ...base(), pattern: "\\p{Extended_Pictographic}", flags: "u" }])).ok).toBe(true);
    expect(parseRulesFile(fileOf([{ ...base(), pattern: "\\\\p\\{x\\}" }])).ok, "an escaped backslash before p is not \\p").toBe(true);
  });
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

  test("each string is capped at FIELD_CAP, a Bash command at the lower COMMAND_CAP", () => {
    const [s] = extractField({ tool_name: "Write", tool_input: { content: "x".repeat(FIELD_CAP + 10) } }, "added");
    expect(s!.length).toBe(FIELD_CAP);
    const [c] = extractField({ tool_name: "Bash", tool_input: { command: "x".repeat(FIELD_CAP) } }, "command");
    expect(c!.length).toBe(COMMAND_CAP);
    expect(COMMAND_CAP).toBeLessThan(FIELD_CAP);
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

  // Literals the rules match are assembled at runtime, so this file itself
  // never holds one (the tracked-files guard below reads it too).
  const CATCH = "catch";
  const EMPTY = "{" + "}";
  const cases: Array<[string, Record<string, unknown>[], Record<string, unknown>[]]> = [
    [
      "empty-catch",
      [
        write(`try { x() } ${CATCH} ${EMPTY}`),
        write(`try { x() } ${CATCH} (e) { }`),
        write(`p.${CATCH}(() => ${EMPTY})`),
        write(`p.${CATCH}((err) => { })`),
        write(`p.${CATCH}(async () => ${EMPTY})`),
        write(`p.${CATCH}((_e: unknown) => ${EMPTY})`),
        write(`p.${CATCH}(function () ${EMPTY})`),
        write(`try { x() } ${CATCH} (e) { /* ignore */ }`),
        write(`try { x() } ${CATCH} (e) {\n  // noop\n}`),
      ],
      [
        write(`try { x() } ${CATCH} (e) { log(e) }`),
        write(`p.${CATCH}((e) => report(e))`),
        write(`try { x() } ${CATCH} {\n  // not a git repo: the caller falls back to the cwd\n}`),
        write(`expect(src).not.toContain('${CATCH} ${EMPTY}')`),
        pre("Write", { file_path: "/x/README.md", content: `never write \`${CATCH} ${EMPTY}\`` }),
        pre("Write", { file_path: "/x/doc.mdx", content: `${CATCH} ${EMPTY}` }),
      ],
    ],
    ["control-byte", [write("a\x1b[0m"), write("nul\x00"), write("bell\x07")], [write("a\\x1b[0m"), write("tab\tnewline\n")]],
    [
      "git-add-all",
      [
        bash("git add -A"),
        bash("git add ."),
        bash("git add --all && git commit"),
        bash("git -C repo add -v ."),
        bash("cd x && git add -A && git commit -m y"),
        bash("git -c core.x=y add -A"),
        bash("git --no-pager add -A"),
        bash("git add -- ."),
        bash("GIT_TRACE=1 git add -A"),
        bash("(cd x; git add .)"),
      ],
      [
        bash("git add src/a.ts"),
        bash("git add ./src/a.ts"),
        bash("git add -p"),
        bash(`git commit -m "feat: deny git add -A and git add ."`),
        bash("echo 'never run git add -A'"),
        bash("git add f.ts && echo ."),
        bash(`git add f.ts && git commit -m "see -A"`),
        bash("grep -rn 'git add -A' ."),
      ],
    ],
    [
      "git-no-verify",
      [
        bash("git commit --no-verify -m x"),
        bash("git push --no-verify"),
        bash("git commit -n -m x"),
        bash("git commit -an -m x"),
        bash("git -c k=v commit --no-verify"),
      ],
      [
        bash("git commit -m 'verify'"),
        bash("grep no-verify-foo x"),
        bash("grep -rn -- --no-verify ."),
        bash("rg '--no-verify' src"),
        bash(`git commit -m "docs: why --no-verify is banned"`),
        bash("git push -n origin x"),
        bash("git merge -n topic"),
        bash("git commit -uno -m x"),
      ],
    ],
    [
      "git-force-push",
      [
        bash("git push --force"),
        bash("git push -f origin main"),
        bash("git push origin +main"),
        bash("git push -uf origin x"),
        bash("git -c k=v push --force"),
        bash("git --no-pager push --force"),
        bash("git push --force-if-includes --force"),
      ],
      [
        bash("git push --force-with-lease"),
        bash("git push --force-with-lease=main:abc origin main"),
        bash("git push -u origin feat-f"),
        bash("git push --follow-tags"),
        bash("git push && rm -f x"),
        bash(`git commit -m "docs: explain why git push --force is banned"`),
        bash(`git log --grep "git push --force"`),
        bash(`echo "do not git push --force"`),
        bash("git push -o ci.skip origin x"),
      ],
    ],
    [
      "secret-literal",
      [
        write(`const k = "${"sk-" + "ant-"}api03-abcdefghijkl"`),
        write(`t = ${"gh" + "p_"}${"a".repeat(36)}`),
        write(`t = ${"gh" + "o_"}abcdefghijklmnopqrstuvwxyz0123`),
        write(`t = ${"gh" + "s_"}abcdefghijklmnopqrstuvwxyz0123`),
        write(`t = ${"gh" + "u_"}abcdefghijklmnopqrstuvwxyz0123`),
        write(`t = ${"gh" + "r_"}abcdefghijklmnopqrstuvwxyz0123`),
        write(`k = ${"sk-" + "proj-"}abcdefghijklmnopqrstuvwxyz`),
        write(`s = ${"xo" + "xb-"}1234-5678-abcdefgh`),
        write(`s = ${"xo" + "xp-"}1234-5678-abcdefgh`),
        write(`id = ${"AK" + "IA"}QWERTYUIOPASDFGH`),
        write(`${"-----BEGIN " + "RSA PRIVATE"} KEY-----`),
      ],
      [
        write("const k = process.env.ANTHROPIC_API_KEY"),
        write("-----BEGIN PUBLIC KEY-----"),
        write(`id = ${"AK" + "IA"}IOSFODNN7EXAMPLE`),
        write(`export ANTHROPIC_API_KEY=${"sk-" + "ant-"}xxxxxxxxxx`),
        write(`export ANTHROPIC_API_KEY=${"sk-" + "ant-"}api03-XXXXXXXXXXXX`),
        write(`t = ${"gh" + "p_"}${"x".repeat(36)}`),
        write(`t = ${"gh" + "p_"}${"0".repeat(36)}`),
      ],
    ],
  ];

  for (const [id, positives, negatives] of cases) {
    test(`${id}: fires on positives, silent on negatives`, () => {
      for (const p of positives) expect({ id, input: p.tool_input, fired: firesKory(id, p) }).toMatchObject({ fired: true });
      for (const p of negatives) expect({ id, input: p.tool_input, fired: firesKory(id, p) }).toMatchObject({ fired: false });
    });
  }

  test("built-ins apply to MultiEdit: any one edit triggers", () => {
    const p = pre("MultiEdit", { file_path: "/x/a.ts", edits: [{ new_string: "ok" }, { new_string: `x ${CATCH} ${EMPTY}` }] });
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

describe("evaluate: hook order, short-circuit, failures, Write over an existing file", () => {
  const rule = (id: string, over: Partial<TtsrRule>, source: "kory" | "repo" | "user" = "repo"): TtsrEffectiveRule =>
    qualifyRule(source, { ...(base() as unknown as TtsrRule), id, ...over });
  const write = (file_path: string, content: string) => pre("Write", { file_path, content });

  test("hookEvaluationOrder: denies before warns, Kory then user then repo, stable within a group", () => {
    const rules = [
      rule("w1", { mode: "warn" }, "kory"),
      rule("d-repo", {}, "repo"),
      rule("d-user", {}, "user"),
      rule("d-kory", {}, "kory"),
      rule("d-kory-2", {}, "kory"),
      rule("w2", { mode: "warn" }, "repo"),
    ];
    expect(hookEvaluationOrder(rules).map((r) => r.qualifiedId)).toEqual([
      "kory/d-kory",
      "kory/d-kory-2",
      "user/d-user",
      "repo/d-repo",
      "kory/w1",
      "repo/w2",
    ]);
  });

  test("stopAtFirstDeny: the first deny ends the evaluation, no later rule or warn runs", () => {
    let calls = 0;
    const later = rule("later", { paths: ["**"] });
    const rules = hookEvaluationOrder([rule("w", { mode: "warn" }, "user"), later, rule("first", {}, "kory")]);
    const res = evaluate(rules, write("/x/a.ts", "foo"), () => (calls++, "/x"), { stopAtFirstDeny: true });
    expect(res.denies.map((d) => d.qualifiedId)).toEqual(["kory/first"]);
    expect(res.warns, "no warn is evaluated once a deny is known").toEqual([]);
    expect(calls, "a rule after the first deny must not even resolve the project root").toBe(0);
  });

  test("the project root function runs lazily, once, and only after a rule with paths matched its field", () => {
    let calls = 0;
    const root = () => (calls++, "/x");
    const scoped = [rule("a", { paths: ["src/**"] }), rule("b", { paths: ["src/**"], pattern: "bar" })];
    evaluate(scoped, write("/x/src/a.ts", "nothing here"), root);
    expect(calls, "no field matched: no root lookup").toBe(0);
    const res = evaluate(scoped, write("/x/src/a.ts", "foo bar"), root);
    expect(res.denies).toHaveLength(2);
    expect(calls, "resolved once for every rule of the call").toBe(1);
  });

  test("a path that cannot be canonicalized (ELOOP) skips that rule with an error; the other rules still deny", () => {
    const dir = mkdtempSync(join(tmpdir(), "ttsr-loop-"));
    tmpRoots.push(dir);
    symlinkSync(join(dir, "b"), join(dir, "a"));
    symlinkSync(join(dir, "a"), join(dir, "b"));
    const rules = [rule("scoped", { paths: ["src/**"] }), rule("plain", {}, "kory")];
    const res = evaluate(rules, write(join(dir, "a", "x.ts"), "foo"), dir);
    expect(res.denies.map((d) => d.qualifiedId), "one rule's path failure must not cancel another rule's deny").toEqual([
      "kory/plain",
    ]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^repo\/scoped: .*(ELOOP|loop)/i);
  });

  test("Write over an existing file fires only on a match the file did not already hold", () => {
    const r = rule("no-foo", {});
    const old = "a foo\nb\n";
    const readExisting = () => old;
    expect(evaluate([r], write("/x/a.ts", old), "/x", { readExisting }).denies, "rewriting the same content").toHaveLength(0);
    expect(evaluate([r], write("/x/a.ts", `${old}c\n`), "/x", { readExisting }).denies, "an unrelated addition").toHaveLength(0);
    expect(evaluate([r], write("/x/a.ts", `${old}foo\n`), "/x", { readExisting }).denies, "a second occurrence").toHaveLength(1);
    expect(evaluate([r], write("/x/a.ts", "foo"), "/x", { readExisting: () => null }).denies, "a new file").toHaveLength(1);
    const edit = pre("Edit", { file_path: "/x/a.ts", new_string: "foo" });
    expect(evaluate([r], edit, "/x", { readExisting }).denies, "Edit is untouched: new_string is all added text").toHaveLength(1);
    const failing = evaluate([r, rule("other", { pattern: "a foo" }, "kory")], write("/x/a.ts", `${old}foo`), "/x", {
      readExisting: () => {
        throw new Error("EISDIR: illegal operation on a directory");
      },
    });
    expect(failing.errors.map((e) => e.split(":")[0])).toEqual(["repo/no-foo", "kory/other"]);
    expect(failing.denies).toEqual([]);
  });

  test("an exclusion-only rule still applies outside the project, its exclusions tested on the absolute path", () => {
    const r = rule("r", { paths: ["!**/*.md"] });
    expect(evaluate([r], write("/elsewhere/a.ts", "foo"), "/x").denies).toHaveLength(1);
    expect(evaluate([r], write("/elsewhere/a.md", "foo"), "/x").denies).toHaveLength(0);
    const inc = rule("i", { paths: ["**"] });
    expect(evaluate([inc], write("/elsewhere/a.ts", "foo"), "/x").denies, "an include glob never matches outside").toHaveLength(0);
  });
});

describe("the repository's own tracked files (false-positive guard of the built-ins)", () => {
  const REPO = resolve(import.meta.dir, "..");
  const denies = KORY_EFFECTIVE_RULES.filter((r) => r.mode === "deny");
  const write = (file_path: string, content: string) => pre("Write", { file_path, content });
  // `git ls-files --eol`: "i/<eol> w/<eol> attr/<attr>\t<path>", i/-text = binary for git.
  const listed = spawnSync("git", ["ls-files", "--eol", "-z"], { cwd: REPO, encoding: "utf8" });
  const textFiles = listed.stdout
    .split("\0")
    .filter((e) => e.includes("\t") && !e.startsWith("i/-text"))
    .map((e) => e.slice(e.indexOf("\t") + 1));
  const contentOf = (rel: string): string | null => {
    try {
      return readFileSync(join(REPO, rel), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };

  test("git lists the tracked text files", () => {
    expect(listed.status, listed.stderr).toBe(0);
    expect(textFiles.length).toBeGreaterThan(100);
  });

  test("no built-in deny fires on a Write of any tracked file's current content", () => {
    for (const rel of textFiles) {
      const content = contentOf(rel);
      if (content === null) continue;
      const abs = join(REPO, rel);
      const res = evaluate(denies, write(abs, content), REPO, { readExisting: () => content });
      expect(res.denies.map((d) => d.qualifiedId), `a Write of the current content of ${rel} would be denied`).toEqual([]);
      expect(res.errors, `rules not evaluated on ${rel}`).toEqual([]);
    }
  });

  test("secret-literal and control-byte fire on no tracked file even as brand-new content (placeholders excluded)", () => {
    const pure = denies.filter((r) => r.id === "secret-literal" || r.id === "control-byte");
    expect(pure).toHaveLength(2);
    for (const rel of textFiles) {
      const content = contentOf(rel);
      if (content === null) continue;
      const res = evaluate(pure, write(join(REPO, rel), content), REPO);
      expect(res.denies.map((d) => d.qualifiedId), `writing ${rel} as a new file would be denied`).toEqual([]);
    }
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

describe("timing probe seeds", () => {
  test("a Unicode property yields characters it accepts; defaults include an uppercase letter and a digit", async () => {
    const { probeSeeds } = await import("../desktop/src/shared/ttsr-probe");
    expect(probeSeeds("\\p{Lu}+x", "u"), "\\p{Lu} must be probed with uppercase runs, the only ones it accepts").toContain("A");
    expect(probeSeeds("\\p{Ll}+x", "u")).toContain("a");
    expect(probeSeeds("\\p{Nd}+x", "u")).toContain("0");
    expect(probeSeeds("\\p{Extended_Pictographic}+x", "u"), "an emoji property needs an emoji seed").toContain("\u{1f600}");
    const unknown = probeSeeds("\\p{Script=Greek}+x", "u");
    expect(unknown.length, "an unknown property falls back to several scripts").toBeGreaterThan(5);
    expect(unknown).toContain("α");
    expect(probeSeeds("x"), "default seeds").toEqual(expect.arrayContaining(["a", "A", "0"]));
    expect(probeSeeds(".+x", "u"), "a u-flag pattern also gets a non-ASCII seed").toContain("é");
  });

  test("the probe rejects cubic \\p{Lu} and bounded [A-Z] repetitions the old 'a'-only seeds let through", async () => {
    const { probeRulesSpeed } = await import("../desktop/src/shared/ttsr-probe");
    const mk = (pattern: string, flags?: string) => ({
      id: "r",
      event: "PreToolUse" as const,
      tools: ["Bash" as const],
      field: "command" as const,
      pattern,
      ...(flags ? { flags } : {}),
      mode: "deny" as const,
      message: "Do not do this; do the other thing instead.",
    });
    const errors = await probeRulesSpeed([mk("\\p{Lu}{0,99}\\p{Lu}{0,99}\\p{Lu}{0,99};", "u"), mk("[A-Z]{0,200}[A-Z]{0,200}[A-Z]{0,200};")]);
    expect(errors, "both slow patterns must be refused by the timing gate").toHaveLength(2);
    for (const e of errors) expect(e).toContain("too slow");
  }, 30000);
});
