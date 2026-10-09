// TTSR ("Time Traveling Stream Rules") hook: matches the incoming PreToolUse
// or PostToolUse call against the per-tile effective rules file the Deck
// compiled (kory + global + approved repo rules) and denies the call or
// injects the matched rule text, through the shared rules engine.
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
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { readBounded } from "../src/shared/ttsr-fs.ts";
import {
  buildHookOutput,
  evaluate,
  FIELD_CAP,
  hookEvaluationOrder,
  parseEffectiveFile,
  TTSR_EVALUATE_DEADLINE_MS,
  TTSR_REGEX_BUDGET_MS,
  type TtsrEffectiveRule,
  type TtsrEvent,
  type TtsrMatch,
  type TtsrOverBudget,
} from "../src/shared/ttsr-rules.ts";

/**
 * Wall clock of the whole hook, from process start, under Claude Code's 10 s
 * hook timeout past which the call goes through. A JavaScriptCore regex can
 * run for tens of seconds without being cut, and worker.terminate() does not
 * interrupt it: the evaluation runs in a Worker, and at the wall the main
 * thread decides from what was reported and exits the process.
 */
export const TTSR_HOOK_WALL_MS = 6000;
const WORKER_FLAG = "ttsrHookRaw";

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

export interface ApplicableRules {
  event: TtsrEvent;
  /** In hook evaluation order. */
  rules: TtsrEffectiveRule[];
}

/**
 * The rules of the effective file named by $CLAUDE_PEERS_TTSR_FILE that apply
 * to this call, or null when there is nothing to decide (no file, an invalid
 * one, or no rule for this event and tool). Runs no regex.
 */
export function applicableRules(payload: HookPayload): ApplicableRules | null {
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
  return { event, rules: hookEvaluationOrder(applicable) };
}

/** Evaluates the applicable rules: the hook's stdout decision, or null for no decision. */
export function evaluateApplicable(
  payload: HookPayload,
  found: ApplicableRules,
  onDecided?: (qualifiedId: string, match: TtsrMatch | null) => void
): Record<string, unknown> | null {
  const result = evaluate(found.rules, payload, () => projectRootOf(payload), {
    stopAtFirstDeny: true,
    readExisting,
    onDecided,
  });
  for (const err of result.errors) trace(`rule not evaluated: ${err}`);
  for (const o of result.overBudget) trace(overBudgetTraceLine(o));
  return buildHookOutput(found.event, result);
}

/**
 * Builds the hook's stdout decision, or null for no decision (falls through
 * to the normal permission flow).
 */
export function decide(payload: HookPayload): Record<string, unknown> | null {
  const found = applicableRules(payload);
  return found ? evaluateApplicable(payload, found) : null;
}

export function overBudgetTraceLine(o: TtsrOverBudget): string {
  const action = o.mode === "deny" ? "denied by default" : "not applied";
  switch (o.reason) {
    case "threw":
      return `rule evaluation threw (${o.mode}, ${action}): ${o.qualifiedId} on ${o.field} (${o.chars} chars): ${o.error}`;
    case "budget":
      return `regex over budget (${o.mode}, ${action}): ${o.qualifiedId} took ${o.ms} ms on ${o.field} (${o.chars} chars), budget ${TTSR_REGEX_BUDGET_MS} ms`;
    case "deadline":
      return `evaluation deadline exceeded (${o.mode}, ${action}): ${o.qualifiedId} after ${o.ms} ms, deadline ${TTSR_EVALUATE_DEADLINE_MS} ms`;
  }
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

/**
 * The decision from what was decided before the wall: decided matches stand,
 * an undecided deny counts as a deny, an undecided warn does not apply.
 */
export function composeWallDecision(
  event: TtsrEvent,
  applicable: readonly TtsrMatch[],
  decided: ReadonlyMap<string, TtsrMatch | null>,
  why = `hook wall of ${TTSR_HOOK_WALL_MS} ms exceeded`
): { output: Record<string, unknown> | null; undecided: string[] } {
  const denies: TtsrMatch[] = [];
  const warns: TtsrMatch[] = [];
  const undecided: string[] = [];
  for (const rule of applicable) {
    if (decided.has(rule.qualifiedId)) {
      const match = decided.get(rule.qualifiedId);
      if (match) (match.mode === "deny" ? denies : warns).push(match);
      continue;
    }
    undecided.push(rule.qualifiedId);
    if (rule.mode === "deny") {
      denies.push({ ...rule, message: `${rule.message} (TTSR: ${why}; denied by default)` });
    }
  }
  return { output: buildHookOutput(event, { denies, warns }), undecided };
}

type WorkerMessage =
  | { type: "decided"; qualifiedId: string; match: TtsrMatch | null }
  | { type: "out"; out: string }
  | { type: "failed"; error: string };

export interface WorkerInput {
  [WORKER_FLAG]: true;
  raw: string;
  found: ApplicableRules;
}

/**
 * The applicable rules are read here, before the Worker starts, so a wall,
 * a crash or an exception at any point of the evaluation is decided from
 * them: a deny not yet decided is not let through.
 */
export function runHookBounded(
  raw: string,
  wallMs: number,
  startWorker: (input: WorkerInput) => Worker = (input) => new Worker(new URL(import.meta.url), { workerData: input })
): Promise<string> {
  let found: ApplicableRules | null;
  try {
    found = applicableRules(parseHookPayload(raw));
  } catch (e) {
    trace(`internal error before the rules were read, failing open: ${errorText(e)}`);
    return Promise.resolve("");
  }
  if (!found) return Promise.resolve("");
  const known = found;
  const applicable = known.rules.map((r) => ({ qualifiedId: r.qualifiedId, mode: r.mode, message: r.message }));
  return new Promise((resolve) => {
    let settled = false;
    const decided = new Map<string, TtsrMatch | null>();
    const finish = (out: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    const fromPartial = (why: string): void => {
      if (settled) return;
      const { output, undecided } = composeWallDecision(known.event, applicable, decided, why);
      trace(`${why}, undecided rules (deny counts as deny, warn not applied): ${undecided.join(", ")}`);
      finish(output ? JSON.stringify(output) : "");
    };
    const timer = setTimeout(() => fromPartial(`hook wall of ${TTSR_HOOK_WALL_MS} ms exceeded`), Math.max(0, wallMs));
    const input: WorkerInput = { [WORKER_FLAG]: true, raw, found: known };
    let worker: Worker;
    try {
      worker = startWorker(input);
    } catch (e) {
      fromPartial(`the evaluation worker could not start (${errorText(e)})`);
      return;
    }
    worker.on("message", (m: WorkerMessage) => {
      if (m.type === "decided") decided.set(m.qualifiedId, m.match);
      else if (m.type === "failed") fromPartial(`internal error (${m.error})`);
      else finish(m.out);
    });
    worker.once("error", (e) => fromPartial(`the evaluation worker crashed (${errorText(e)})`));
    worker.once("exit", (code) => fromPartial(`the evaluation worker exited without a decision (code ${code})`));
  });
}

if (!isMainThread && parentPort && (workerData as Partial<WorkerInput> | null)?.[WORKER_FLAG] === true) {
  const port = parentPort;
  const post = (m: WorkerMessage): void => port.postMessage(m);
  const input = workerData as WorkerInput;
  try {
    const decision = evaluateApplicable(parseHookPayload(input.raw), input.found, (qualifiedId, match) =>
      post({ type: "decided", qualifiedId, match })
    );
    post({ type: "out", out: decision ? JSON.stringify(decision) : "" });
  } catch (e) {
    post({ type: "failed", error: errorText(e) });
  }
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

if (import.meta.main) {
  // Exit 0 always, never 2 (a block): no decision means the normal
  // permission flow applies. process.exit also ends a worker stuck in a regex.
  void readStdin()
    .then((raw) => runHookBounded(raw, TTSR_HOOK_WALL_MS - performance.now()))
    .then(
      (out) =>
        new Promise<void>((resolve) => {
          if (!out) return resolve();
          // exit() right after write() can drop a decision still buffered on a pipe.
          const fallback = setTimeout(resolve, 200);
          process.stdout.write(out, () => {
            clearTimeout(fallback);
            resolve();
          });
        })
    )
    .catch((e) => trace(`fatal, failing open: ${errorText(e)}`))
    .finally(() => process.exit(0));
}
