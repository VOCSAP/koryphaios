// TTSR ("Time Traveling Stream Rules") hook: matches the incoming PreToolUse
// or PostToolUse call against the per-tile effective rules file the Deck
// compiled (kory + global + approved repo rules) and denies the call or
// injects the matched rule text, per desktop/src/shared/ttsr-rules.ts.
//
// Fails open on every internal error, and never exits 2 (Claude Code treats
// exit 2 as a block): a bug here must never stop a session from working.
// Traces go to stderr and to $CLAUDE_PEERS_TTSR_LOG, a per-tile file the Deck
// tails into its own error log.
//
// Deny rules run first, Kory rules first among them, and the first deny ends
// the evaluation: a slow user or repo rule can hold the hook up, never cancel
// a Kory deny that runs before it.

import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { readBounded } from "../src/shared/ttsr-fs.ts";
import {
  buildHookOutput,
  evaluate,
  FIELD_CAP,
  hookEvaluationOrder,
  parseEffectiveFile,
  type TtsrEvent,
} from "../src/shared/ttsr-rules.ts";

const TTSR_FILE_ENV = "CLAUDE_PEERS_TTSR_FILE";
const TTSR_LOG_ENV = "CLAUDE_PEERS_TTSR_LOG";
/** Bytes of a Write target read to compare with the new content: the cap in UTF-16 units, 4 bytes each at worst. */
const EXISTING_READ_BYTES = FIELD_CAP * 4;

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Traces one line: always to stderr, and to $CLAUDE_PEERS_TTSR_LOG when it
 * is set. Never throws -- a broken log path must not turn a fail-open trace
 * into a fresh failure; the log failure itself is written to stderr.
 */
export function trace(message: string): void {
  const line = `[ttsr-hook] ${message}`;
  process.stderr.write(`${line}\n`);
  const logPath = process.env[TTSR_LOG_ENV];
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    process.stderr.write(`[ttsr-hook] cannot append to ${logPath}: ${errorText(e)}\n`);
  }
}

/** The hook input, or {} (traced) when stdin is not a JSON object. */
export function parseHookPayload(raw: string): HookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    trace(`stdin is not JSON (${raw.length} chars), no rule applied: ${errorText(e)}`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    trace(`stdin is not a JSON object, no rule applied`);
    return {};
  }
  return parsed as HookPayload;
}

/**
 * Project root the `paths` globs are relative to: the git toplevel of the
 * session's project dir, as the Deck and the CLI compute it, so a session
 * launched in a subdirectory still matches `src/**`. Outside a repository
 * the dir itself. Only called when a rule with `paths` needs it.
 */
export function projectRootOf(payload: HookPayload): string {
  const dir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });
  if (res.error) trace(`git rev-parse failed in ${dir}, taking it as the project root: ${res.error.message}`);
  const top = res.status === 0 && typeof res.stdout === "string" ? res.stdout.trim() : "";
  return top || dir;
}

/**
 * Current content of a Write target (its first bytes), null when it does not
 * exist. Anything but a regular file reached without a symlink (a symlink,
 * a FIFO, a device) is read as absent without being opened for real: the
 * rules then judge the whole new content, the strict side, and a FIFO can
 * never block the hook. The target is opened once, non-blocking, never
 * following a symlink, and checked on the descriptor. An unreadable target
 * is traced and read as absent too.
 */
export function readExisting(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return null;
    if (!st.isFile()) {
      trace(`Write target ${path} is not a regular file, its whole new content is checked`);
      return null;
    }
    const res = readBounded(path, { cap: EXISTING_READ_BYTES, overflow: "truncate" });
    if (res.kind === "absent") return null;
    if (res.kind === "refused") {
      trace(`Write target ${path} ${res.reason}, its whole new content is checked`);
      return null;
    }
    return res.bytes.toString("utf8");
  } catch (e) {
    if (!isMissing(e)) trace(`cannot read the Write target ${path}, its whole new content is checked: ${errorText(e)}`);
    return null;
  }
}

/**
 * Builds the hook's stdout decision, or null for no decision (falls through
 * to the normal permission flow). Reads and evaluates the effective rules
 * file named by $CLAUDE_PEERS_TTSR_FILE. A rule that could not be evaluated
 * is traced and skipped; the others still run.
 */
export function decide(payload: HookPayload): Record<string, unknown> | null {
  const event = payload.hook_event_name as TtsrEvent | undefined;
  const tool = payload.tool_name;
  if (event !== "PreToolUse" && event !== "PostToolUse") return null;
  if (!tool) return null;

  const filePath = process.env[TTSR_FILE_ENV];
  if (!filePath) return null;

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    // Missing: no rules for this tile (outside a Deck tile, or the Deck
    // removed it). Anything else is a fault worth a trace.
    if (!isMissing(e)) trace(`cannot read effective rules file ${filePath}, no rules applied: ${errorText(e)}`);
    return null;
  }

  const parsed = parseEffectiveFile(text);
  if (!parsed.ok) {
    trace(`invalid effective rules file at ${filePath}, no rules applied: ${parsed.errors.join("; ")}`);
    return null;
  }

  // Cheap pre-filter: most tool calls match no rule at all for this
  // event+tool, and this check touches neither the filesystem nor a regex.
  const applicable = parsed.file.rules.filter(
    (r) => r.event === event && (r.tools as readonly string[]).includes(tool)
  );
  if (applicable.length === 0) return null;

  const result = evaluate(hookEvaluationOrder(applicable), payload, () => projectRootOf(payload), {
    stopAtFirstDeny: true,
    readExisting,
  });
  for (const err of result.errors) trace(`rule not evaluated: ${err}`);
  return buildHookOutput(event, result);
}

/** What the hook prints for one stdin text ('' for no decision); fails open with a trace. */
export function runHook(raw: string, decideFn: (p: HookPayload) => Record<string, unknown> | null = decide): string {
  try {
    const decision = decideFn(parseHookPayload(raw));
    return decision ? JSON.stringify(decision) : "";
  } catch (e) {
    trace(`internal error, failing open: ${errorText(e)}`);
    return "";
  }
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

if (import.meta.main) {
  // Exit 0 always, never 2 (a block): no decision means the normal
  // permission flow applies.
  void readStdin()
    .then((raw) => {
      const out = runHook(raw);
      if (out) process.stdout.write(out);
    })
    .catch((e) => trace(`fatal, failing open: ${errorText(e)}`))
    .finally(() => process.exit(0));
}
