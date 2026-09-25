// TTSR ("Time Traveling Stream Rules") hook: matches the incoming PreToolUse
// or PostToolUse call against the per-tile effective rules file the Deck
// compiled (kory + global + approved repo rules) and denies the call or
// injects the matched rule text, per desktop/src/shared/ttsr-rules.ts.
//
// Fails open on every internal error, and never exits 2 (Claude Code treats
// exit 2 as a block): a bug here must never stop a session from working.
// This hook has no Deck log sink of its own -- it traces to
// $CLAUDE_PEERS_TTSR_LOG when set (best effort) and always to stderr, which
// Claude Code surfaces in verbose/debug mode.

import { appendFileSync, readFileSync } from "node:fs";
import {
  buildHookOutput,
  evaluate,
  parseEffectiveFile,
  type TtsrEvent,
} from "../src/shared/ttsr-rules.ts";

const TTSR_FILE_ENV = "CLAUDE_PEERS_TTSR_FILE";
const TTSR_LOG_ENV = "CLAUDE_PEERS_TTSR_LOG";

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/**
 * Traces one line: always to stderr, and best-effort to $CLAUDE_PEERS_TTSR_LOG
 * when it is set. Never throws -- a broken log path must not turn a fail-open
 * trace into a fresh failure that the caller then has to fail open on too.
 */
export function trace(message: string): void {
  const line = `[ttsr-hook] ${message}`;
  process.stderr.write(`${line}\n`);
  const logPath = process.env[TTSR_LOG_ENV];
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Best effort only: the stderr write above already carries the trace.
  }
}

export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

function projectDirOf(payload: HookPayload): string {
  return process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
}

/**
 * Builds the hook's stdout decision, or null for no decision (falls through
 * to the normal permission flow). Reads and evaluates the effective rules
 * file named by $CLAUDE_PEERS_TTSR_FILE. Can throw on a genuinely unexpected
 * condition (evaluate() throws on an unexpected filesystem error while
 * canonicalizing a path) -- the caller traces and fails open on that.
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
  } catch {
    // Missing/unreadable effective file: no rules to apply. This is the
    // expected steady state outside a Deck tile (or a narrow race with the
    // Deck rewriting it), not an error worth tracing.
    return null;
  }

  const parsed = parseEffectiveFile(text);
  if (!parsed.ok) {
    trace(`invalid effective rules file at ${filePath}, no rules applied: ${parsed.errors.join("; ")}`);
    return null;
  }

  // Cheap pre-filter before evaluate()'s field extraction and path
  // canonicalization: most tool calls match no rule at all for this
  // event+tool, and this check alone touches neither the filesystem nor a
  // single regex.
  const applicable = parsed.file.rules.some(
    (r) => r.event === event && (r.tools as readonly string[]).includes(tool)
  );
  if (!applicable) return null;

  const result = evaluate(parsed.file.rules, payload, projectDirOf(payload));
  return buildHookOutput(event, result);
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  const payload = parseHookPayload(await readStdin());
  let decision: Record<string, unknown> | null = null;
  try {
    decision = decide(payload);
  } catch (e) {
    trace(`internal error, failing open: ${(e as Error).message}`);
    decision = null;
  }
  if (decision) process.stdout.write(JSON.stringify(decision));
  // No decision -> no stdout, exit 0: normal permission flow applies.
}

if (import.meta.main) {
  // Fail open unconditionally, exit 0 always -- never exit 2, which Claude
  // Code treats as a block. decide()'s own try/catch already traces an
  // evaluation error; this outer catch only covers a stdin-read failure.
  void main()
    .catch((e) => trace(`fatal, failing open: ${(e as Error).message}`))
    .finally(() => process.exit(0));
}
