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
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  FIELD_CAP,
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

function defaultRulesPath(): string {
  const root = gitRoot(process.cwd()) ?? process.cwd();
  return join(root, DEFAULT_RULES_RELPATH);
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
  const filePath = args[0] ?? defaultRulesPath();
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    fail(`cannot read ${filePath}: ${(e as Error).message}`);
  }
  const parsed = parseRulesFile(text);
  if (!parsed.ok) {
    process.stdout.write(`invalid: ${filePath}\n`);
    for (const err of parsed.errors) process.stdout.write(`  ${err}\n`);
    process.exit(1);
  }
  const byMode = parsed.file.rules.reduce(
    (acc, r) => {
      acc[r.mode]++;
      return acc;
    },
    { deny: 0, warn: 0 }
  );
  process.stdout.write(
    `valid: ${filePath} -- ${parsed.file.rules.length} rule(s) (${byMode.deny} deny, ${byMode.warn} warn)\n`
  );
}

// --- list ---

function readEffectiveRules(): { rules: TtsrEffectiveRule[] } | null {
  const filePath = process.env[TTSR_FILE_ENV];
  if (!filePath) return null;
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
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
  const filePath = args[0] ?? defaultRulesPath();
  let repoRules: TtsrRule[] = [];
  let haveFile = true;
  try {
    statSync(filePath);
  } catch {
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
  if (!effective) {
    process.stdout.write(
      `$${TTSR_FILE_ENV} is not set (not running inside a Kory tile); repo rule approval status is unknown.\n`
    );
  }

  if (repoRules.length > 0) {
    process.stdout.write(`repo rules (${filePath}):\n`);
    for (const r of repoRules) {
      let status: string;
      if (!effective) status = "unknown (no Kory tile)";
      else {
        const active = effective.rules.find((e) => e.qualifiedId === `repo/${r.id}`);
        status = active && sameRule(r, active) ? "active" : "pending-approval";
      }
      process.stdout.write(`  ${r.id}  [${r.event} ${r.tools.join(",")}]  ${status}\n`);
    }
    process.stdout.write(
      "  (repo rule approval happens in the Deck, Settings > Rules -- editing this file never activates a rule by itself)\n"
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
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--text") text = rest[++i];
    else if (a === "--file") {
      const p = rest[++i];
      if (!p) usageError("--file requires a path");
      text = readTextFile(p);
    } else if (a === "--tool") tool = rest[++i] as TtsrTool;
    else if (a === "--path") pathArg = rest[++i];
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

  const projectDir = gitRoot(process.cwd()) ?? process.cwd();
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

  const repoRoot = gitRoot(process.cwd()) ?? process.cwd();
  const allFiles = gitLsFiles(repoRoot);
  const compiled = compilePaths(rule.paths);
  const candidates = rule.paths ? allFiles.filter((f) => pathsAllow(compiled, f)) : allFiles;

  const re = new RegExp(rule.pattern, `${rule.flags ?? ""}g`.replace(/g+/g, "g"));
  const perFile: Array<{ file: string; lines: number }> = [];
  let skipped = 0;
  for (const file of candidates) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(repoRoot, file));
    } catch {
      skipped++;
      continue;
    }
    if (buf.byteLength > FIELD_CAP) {
      skipped++;
      continue;
    }
    // Cheap binary heuristic: a NUL byte in a text file is vanishingly rare
    // and exactly what git itself treats as the binary signal.
    if (buf.includes(0)) {
      skipped++;
      continue;
    }
    const content = buf.toString("utf8");
    let lines = 0;
    for (const line of content.split("\n")) {
      re.lastIndex = 0;
      if (re.test(line)) lines++;
    }
    if (lines > 0) perFile.push({ file, lines });
  }

  perFile.sort((a, b) => b.lines - a.lines);
  const totalLines = perFile.reduce((n, f) => n + f.lines, 0);
  process.stdout.write(
    `${candidates.length} file(s) in scope (of ${allFiles.length} tracked, ${skipped} skipped as binary/oversized): ` +
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
