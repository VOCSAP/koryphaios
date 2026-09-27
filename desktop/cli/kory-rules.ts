#!/usr/bin/env bun
// `kory-rules`: the agent-facing CLI for a repo's TTSR rules file
// (.claude/claude-peers/rules.json), run through the `repo-rules` skill.
// Wraps the shared engine (desktop/src/shared/ttsr-rules.ts) so validation,
// path/field semantics and matching stay identical to what the plugin hook
// actually enforces at runtime -- this CLI never reimplements them.
//
// Read-only towards the file it inspects: there is no `add`/`fix` command.
// An agent edits the JSON with its normal editing tool, then runs `check`.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { probeRulesSpeed } from "../src/shared/ttsr-probe.ts";
import {
  fieldCap,
  globToRegExp,
  parseEffectiveFile,
  parseRulesFile,
  qualifyRule,
  evaluate,
  TTSR_TOOLS,
  type TtsrEffectiveRule,
  type TtsrRule,
  type TtsrTool,
} from "../src/shared/ttsr-rules.ts";

const TTSR_FILE_ENV = "CLAUDE_PEERS_TTSR_FILE";
const DEFAULT_RULES_RELPATH = ".claude/claude-peers/rules.json";
/** Cap on files listed per `scan` match report -- an agent-facing CLI is read
 * token-cheap, not a full report. */
const SCAN_TOP_FILES = 20;

function usageError(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Runs `git <args>` synchronously and returns trimmed stdout, or null on any
 * non-zero exit or spawn failure (not a git repo, git not on PATH). Plain
 * node:child_process, not the Bun.spawn API used by the root cli.ts, so this
 * file typechecks under desktop's tsconfig (no @types/bun there) like every
 * other file under hooks/ and mcp/. */
function runGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function gitRoot(cwd: string): string | null {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function projectRoot(): string {
  return gitRoot(process.cwd()) ?? process.cwd();
}

function defaultRulesPath(): string {
  return join(projectRoot(), DEFAULT_RULES_RELPATH);
}

/**
 * `p` (relative to the cwd) once its real path is known to sit inside the
 * project root: the CLI runs with pre-approved permissions, so it must not
 * become a way to read any file on the machine. Usage error otherwise.
 */
function requireInsideProject(p: string, what: string): string {
  const root = projectRoot();
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(resolve(p));
    realRoot = realpathSync(root);
  } catch (e) {
    fail(`cannot read ${what} ${p}: ${(e as Error).message}`);
  }
  const rel = relative(realRoot, real);
  if (rel !== "" && (isAbsolute(rel) || rel.split(sep)[0] === "..")) {
    usageError(`${what} ${p} is outside the project (${realRoot}); only files of this repository can be read`);
  }
  return real;
}

/** Validation of a rules file: the shared parser, then the timing probe of every pattern. */
async function validateRulesText(text: string): Promise<{ ok: true; rules: TtsrRule[] } | { ok: false; errors: string[] }> {
  const parsed = parseRulesFile(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const slow = await probeRulesSpeed(parsed.file.rules);
  if (slow.length > 0) return { ok: false, errors: slow };
  return { ok: true, rules: parsed.file.rules };
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }
}

// --- check ---

async function cmdCheck(args: string[]): Promise<void> {
  const filePath = args[0] !== undefined ? requireInsideProject(args[0], "rules file") : defaultRulesPath();
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    fail(`cannot read ${filePath}: ${(e as Error).message}`);
  }
  const parsed = await validateRulesText(text);
  if (!parsed.ok) {
    process.stdout.write(`invalid: ${filePath}\n`);
    for (const err of parsed.errors) process.stdout.write(`  ${err}\n`);
    process.exit(1);
  }
  const byMode = parsed.rules.reduce(
    (acc, r) => {
      acc[r.mode]++;
      return acc;
    },
    { deny: 0, warn: 0 }
  );
  process.stdout.write(
    `valid: ${filePath} -- ${parsed.rules.length} rule(s) (${byMode.deny} deny, ${byMode.warn} warn)\n`
  );
}

// --- list ---

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The tile's effective rules; null when not in a tile, or (with a note) when the Deck wrote none. */
function readEffectiveRules(): { rules: TtsrEffectiveRule[] } | null {
  const filePath = process.env[TTSR_FILE_ENV];
  if (!filePath) return null;
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    if (isMissing(e)) {
      process.stdout.write(
        `note: the effective rules file ${filePath} (from $${TTSR_FILE_ENV}) does not exist; the Deck has not compiled rules for this session.\n`
      );
      return null;
    }
    fail(`cannot read effective rules file ${filePath} (from $${TTSR_FILE_ENV}): ${(e as Error).message}`);
  }
  const parsed = parseEffectiveFile(text);
  if (!parsed.ok) fail(`invalid effective rules file ${filePath}: ${parsed.errors.join("; ")}`);
  return { rules: parsed.file.rules };
}

const BASE_RULE_KEYS = ["id", "event", "tools", "field", "paths", "pattern", "flags", "mode", "message"] as const;

/** The base rule fields only, `source`/`qualifiedId` dropped, key order
 * normalized -- what "identical definition" (approval unit) compares. */
function baseRuleJson(r: TtsrRule): string {
  const picked: Partial<TtsrRule> = {
    id: r.id,
    event: r.event,
    tools: r.tools,
    field: r.field,
    pattern: r.pattern,
    mode: r.mode,
    message: r.message,
  };
  if (r.paths !== undefined) picked.paths = r.paths;
  if (r.flags !== undefined) picked.flags = r.flags;
  return JSON.stringify(picked, [...BASE_RULE_KEYS]);
}

/** True when the repo file's rule and the effective file's copy of it are the
 * exact same definition -- a one-character edit must read as pending, not
 * active, until re-approved. */
function sameRule(a: TtsrRule, b: TtsrRule): boolean {
  return baseRuleJson(a) === baseRuleJson(b);
}

async function cmdList(args: string[]): Promise<void> {
  const filePath = args[0] !== undefined ? requireInsideProject(args[0], "rules file") : defaultRulesPath();
  let repoRules: TtsrRule[] = [];
  let haveFile = true;
  try {
    statSync(filePath);
  } catch (e) {
    if (!isMissing(e)) fail(`cannot stat ${filePath}: ${(e as Error).message}`);
    haveFile = false;
  }
  if (haveFile) {
    const parsed = parseRulesFile(readTextFile(filePath));
    if (!parsed.ok) fail(`invalid: ${filePath}\n${parsed.errors.join("\n")}`);
    repoRules = parsed.file.rules;
  } else {
    process.stdout.write(`no repo rules file at ${filePath}\n`);
  }

  const effective = readEffectiveRules();
  if (!effective && process.env[TTSR_FILE_ENV] === undefined) {
    process.stdout.write(
      `$${TTSR_FILE_ENV} is not set (not running inside a Kory tile); repo rule approval status is unknown.\n`
    );
  }

  if (repoRules.length > 0) {
    process.stdout.write(`repo rules (${filePath}):\n`);
    for (const r of repoRules) {
      let status: string;
      if (!effective) status = "unknown (no compiled rules for this session)";
      else {
        const active = effective.rules.find((e) => e.qualifiedId === `repo/${r.id}`);
        // The effective file only holds active rules: pending approval and
        // disabled by the operator look the same from here.
        status = active && sameRule(r, active) ? "active" : "inactive (pending approval or disabled by the operator)";
      }
      process.stdout.write(`  ${r.id}  [${r.event} ${r.tools.join(",")}]  ${status}\n`);
    }
    process.stdout.write(
      "  (approval and the on/off switch live in the Deck, Settings > Rules -- editing this file never activates a rule by itself)\n"
    );
  }

  if (effective) {
    for (const source of ["kory", "user"] as const) {
      const rules = effective.rules.filter((r) => r.source === source);
      if (rules.length === 0) continue;
      process.stdout.write(`${source} rules active:\n`);
      for (const r of rules) process.stdout.write(`  ${r.qualifiedId}  [${r.event} ${r.tools.join(",")}]\n`);
    }
  }
}

// --- test ---

function findRule(rules: TtsrRule[], id: string): TtsrRule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) usageError(`no rule "${id}" in the rules file`);
  return rule;
}

function buildSyntheticPayload(
  rule: TtsrRule,
  tool: TtsrTool,
  text: string,
  pathArg: string | undefined,
  projectDir: string
): Record<string, unknown> {
  const toolInput: Record<string, unknown> = {};
  switch (rule.field) {
    case "added":
      if (tool === "Edit") toolInput.new_string = text;
      else if (tool === "MultiEdit") toolInput.edits = [{ new_string: text }];
      else if (tool === "Write") toolInput.content = text;
      else if (tool === "NotebookEdit") toolInput.new_source = text;
      break;
    case "command":
      toolInput.command = text;
      break;
    case "file_path":
      toolInput.file_path = isAbsolute(text) ? text : join(projectDir, text);
      break;
    case "output":
      toolInput.command = "";
      break;
  }
  const payload: Record<string, unknown> = { hook_event_name: rule.event, tool_name: tool, tool_input: toolInput };
  if (rule.field === "output") payload.tool_response = { stdout: text, stderr: "" };

  if (pathArg && rule.field !== "file_path") {
    const abs = isAbsolute(pathArg) ? pathArg : join(projectDir, pathArg);
    if (tool === "Bash") payload.cwd = abs;
    else toolInput.file_path = abs;
  }
  return payload;
}

async function cmdTest(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) usageError('test requires a rule id, e.g. "test no-emoji-ui --text ..."');
  const rest = args.slice(1);
  let text: string | undefined;
  let tool: TtsrTool | undefined;
  let pathArg: string | undefined;
  let expect: "match" | "none" | undefined;
  const valueOf = (flag: string, i: number): string => {
    const v = rest[i];
    if (v === undefined) usageError(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--text") text = valueOf("--text", ++i);
    else if (a === "--file") text = readTextFile(requireInsideProject(valueOf("--file", ++i), "--file"));
    else if (a === "--tool") tool = valueOf("--tool", ++i) as TtsrTool;
    else if (a === "--path") pathArg = valueOf("--path", ++i);
    else if (a === "--expect") {
      const v = rest[++i];
      if (v !== "match" && v !== "none") usageError('--expect must be "match" or "none"');
      expect = v;
    } else usageError(`unknown argument: ${a}`);
  }
  if (text === undefined) usageError("test requires --text or --file");

  const filePath = defaultRulesPath();
  const parsed = parseRulesFile(readTextFile(filePath));
  if (!parsed.ok) fail(`invalid: ${filePath}\n${parsed.errors.join("\n")}`);
  const rule = findRule(parsed.file.rules, id);

  if (tool !== undefined && !rule.tools.includes(tool)) {
    usageError(`rule "${id}" does not apply to tool "${tool}" (applies to ${rule.tools.join(", ")})`);
  }
  const effectiveTool = tool ?? rule.tools[0]!;
  if (!(TTSR_TOOLS as readonly string[]).includes(effectiveTool)) {
    usageError(`"${effectiveTool}" is not a known tool (${TTSR_TOOLS.join(", ")})`);
  }
  // Without a target the `paths` filter would drop the rule and every test
  // would read "none", whatever the pattern.
  if (rule.paths && rule.paths.length > 0 && pathArg === undefined && rule.field !== "file_path") {
    usageError(
      effectiveTool === "Bash"
        ? `rule "${id}" has paths (${rule.paths.join(", ")}): for Bash they filter on the directory the command runs in, ` +
            'so pass --path <repo-relative dir>, e.g. --path desktop'
        : `rule "${id}" has paths (${rule.paths.join(", ")}): pass --path <repo-relative file> for the file the edit targets, e.g. --path src/a.ts`
    );
  }

  const projectDir = projectRoot();
  const payload = buildSyntheticPayload(rule, effectiveTool, text, pathArg, projectDir);
  const qualified = qualifyRule("repo", rule);
  const result = evaluate([qualified], payload, projectDir);
  const matched = result.denies.length > 0 || result.warns.length > 0;

  process.stdout.write(matched ? `match (${rule.mode})\n` : "none\n");
  if (expect === undefined) return;
  process.exit((expect === "match") === matched ? 0 : 1);
}

// --- scan ---

interface Compiled {
  include: RegExp[];
  exclude: RegExp[];
}

function compilePaths(paths: string[] | undefined): Compiled {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const g of paths ?? []) {
    if (g.startsWith("!")) exclude.push(globToRegExp(g.slice(1)));
    else include.push(globToRegExp(g));
  }
  return { include, exclude };
}

function pathsAllow(c: Compiled, rel: string): boolean {
  if (c.include.length > 0 && !c.include.some((r) => r.test(rel))) return false;
  return !c.exclude.some((r) => r.test(rel));
}

function gitLsFiles(repoRoot: string): string[] {
  const result = spawnSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(`git ls-files failed in ${repoRoot}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

async function cmdScan(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) usageError('scan requires a rule id, e.g. "scan no-emoji-ui"');

  const filePath = defaultRulesPath();
  const parsed = parseRulesFile(readTextFile(filePath));
  if (!parsed.ok) fail(`invalid: ${filePath}\n${parsed.errors.join("\n")}`);
  const rule = findRule(parsed.file.rules, id);

  const repoRoot = projectRoot();
  const allFiles = gitLsFiles(repoRoot);
  const compiled = compilePaths(rule.paths);
  const candidates = rule.paths ? allFiles.filter((f) => pathsAllow(compiled, f)) : allFiles;

  // Same semantics as the hook on a Write of the whole file: one test of the
  // content cut to the field cap; the g regex only locates lines for display.
  const re = new RegExp(rule.pattern, rule.flags ?? "");
  const reAll = new RegExp(rule.pattern, `${rule.flags ?? ""}g`);
  const cap = fieldCap(rule.field);
  const perFile: Array<{ file: string; lines: number }> = [];
  let skipped = 0;
  let unreadable = 0;
  for (const file of candidates) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(repoRoot, file));
    } catch (e) {
      // A tracked file deleted from the work tree is expected; anything else is reported.
      if (!isMissing(e)) process.stderr.write(`warning: cannot read ${file}: ${(e as Error).message}\n`);
      unreadable++;
      continue;
    }
    // A NUL byte is what git itself treats as binary: such a file is never written by Edit/Write.
    if (buf.includes(0)) {
      skipped++;
      continue;
    }
    const full = buf.toString("utf8");
    const content = full.length > cap ? full.slice(0, cap) : full;
    if (!re.test(content)) continue;
    const lines = new Set<number>();
    let line = 1;
    let scanned = 0;
    for (const m of content.matchAll(reAll)) {
      for (; scanned < m.index; scanned++) if (content.charCodeAt(scanned) === 10) line++;
      lines.add(line);
    }
    perFile.push({ file, lines: Math.max(lines.size, 1) });
  }

  perFile.sort((a, b) => b.lines - a.lines);
  const totalLines = perFile.reduce((n, f) => n + f.lines, 0);
  process.stdout.write(
    `${candidates.length} file(s) in scope (of ${allFiles.length} tracked, ${skipped} skipped as binary, ${unreadable} missing): ` +
      `${perFile.length} file(s) match, ${totalLines} matching line(s)\n`
  );
  for (const f of perFile.slice(0, SCAN_TOP_FILES)) process.stdout.write(`  ${f.file}  (${f.lines})\n`);
  if (perFile.length > SCAN_TOP_FILES) process.stdout.write(`  (+${perFile.length - SCAN_TOP_FILES} more)\n`);

  if (rule.mode === "deny" && rule.tools.includes("Write") && perFile.length > 0) {
    process.stdout.write(
      `WARNING: rule "${id}" is deny on Write and already matches existing code above -- ` +
        "approving it as-is would block any future Write that rewrites one of those files whole.\n"
    );
  }
}

// --- entrypoint ---

const HELP = `kory-rules -- inspect and test this repo's TTSR rules file (${DEFAULT_RULES_RELPATH})

Usage:
  kory-rules check [file]              validate the rules file (default: repo rules.json)
  kory-rules list                      repo rules + their $${TTSR_FILE_ENV} approval/active status
  kory-rules test <id> (--text S | --file P) [--tool T] [--path P] [--expect match|none]
                                        run one rule against a synthetic payload
  kory-rules scan <id>                 count matches of one rule's pattern across tracked files
  kory-rules --help                    this text

check also times every pattern on adversarial input and rejects one that
backtracks (too slow for the hook).
test: a rule with "paths" needs --path (the edited file, or for Bash the
directory the command runs in, relative to the repository root).

Exit codes: check/test -- 0 met, 1 not met; usage error -- 2.
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    process.exit(cmd ? 0 : 2);
  }
  switch (cmd) {
    case "check":
      return cmdCheck(rest);
    case "list":
      return cmdList(rest);
    case "test":
      return cmdTest(rest);
    case "scan":
      return cmdScan(rest);
    default:
      usageError(`unknown command "${cmd}" (see --help)`);
  }
}

// Always invoked directly (bun cli/kory-rules.ts ... or the bundled
// deck-plugin/bin/kory-rules.mjs), never imported as a library module, so no
// import.meta.main guard is needed here.
main().catch((e) => fail((e as Error).message));
