import { createHash } from "node:crypto";
export {
  CONTEXT_CLEAR_IDLE_WAIT_MS,
  CONTEXT_CLEAR_ROTATION_WAIT_MS,
  CONTEXT_RESERVATION_RELEASE_MARGIN_MS,
  CONTEXT_RESERVATION_TTL_MS,
} from "./context-timing.ts";

/**
 * The env var carrying a launch's deposit capability. Its name must not end in
 * a suffix that CLAUDE_CODE_SUBPROCESS_ENV_SCRUB strips (_TOKEN, _KEY,
 * _SECRET, ...), or the agent's Bash would silently lose it.
 */
export const DEPOSIT_CAPABILITY_ENV = "CLAUDE_PEERS_DEPOSIT_CAPABILITY";

/** Deposit cap in code points. A tunable setting: raise it when usage asks for more. */
export const CONTEXT_DEPOSIT_MAX_CHARS = 4000;

/**
 * Request body bound, read on Content-Length before any parse. Worst case per
 * code point is a client that escapes every non-ASCII character
 * (`\uXXXX\uXXXX` for an astral one), plus room for the other fields.
 */
export const CONTEXT_DEPOSIT_MAX_BODY_BYTES = CONTEXT_DEPOSIT_MAX_CHARS * 12 + 4096;

/** CLI input bound: past it, the text necessarily exceeds the cap (a code point is at most 4 UTF-8 bytes). */
export const CONTEXT_DEPOSIT_MAX_INPUT_BYTES = CONTEXT_DEPOSIT_MAX_CHARS * 4;

export const CONTEXT_DEPOSITS_PER_OWNER = 3;
export const CONTEXT_DEPOSITS_PER_GROUP = 96;
export const CONTEXT_DEPOSITS_TOTAL = 256;

const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEPOSIT_ID = /^[0-9a-f]{16}$/;
const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const MAX_BRANCH_CHARS = 255;
const MAX_GIT_ROOT_CHARS = 4096;

export function isCapabilityShape(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function isCapabilityHashShape(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function isDepositIdShape(value: unknown): value is string {
  return typeof value === "string" && DEPOSIT_ID.test(value);
}

export function isAttemptIdShape(value: unknown): value is string {
  return typeof value === "string" && ATTEMPT_ID.test(value);
}

export function hashCapability(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

/** The /register field for this launch, or undefined (omitted) when the env holds no well-formed capability. */
export function depositCapabilityHashFromEnv(env: Record<string, string | undefined>): string | undefined {
  const value = env[DEPOSIT_CAPABILITY_ENV];
  return isCapabilityShape(value) ? hashCapability(value) : undefined;
}

export function countCodePoints(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

function isForbiddenCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x061c || cp === 0x200e || cp === 0x200f) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  return cp === 0x2028 || cp === 0x2029;
}

function hasForbiddenCharacter(text: string): boolean {
  for (const ch of text) {
    if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

export type DepositTextVerdict =
  | { ok: true; chars: number }
  | { ok: false; reason: "too_long"; max_chars: number; got_chars: number }
  | { ok: false; reason: "empty_text" | "ill_formed_text" | "forbidden_characters" };

/** Length first, then content: a text over the cap is refused as such, whatever it holds. */
export function validateDepositText(text: string, maxChars: number): DepositTextVerdict {
  const chars = countCodePoints(text);
  if (chars > maxChars) return { ok: false, reason: "too_long", max_chars: maxChars, got_chars: chars };
  if (text.trim() === "") return { ok: false, reason: "empty_text" };
  if (!text.isWellFormed()) return { ok: false, reason: "ill_formed_text" };
  if (hasForbiddenCharacter(text)) return { ok: false, reason: "forbidden_characters" };
  return { ok: true, chars };
}

function isBoundedName(value: unknown, max: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.isWellFormed() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
    !hasForbiddenCharacter(value)
  );
}

export interface GitFacts {
  head: string | null;
  branch: string | null;
  git_root: string | null;
}

/** Client claims, revalidated by the broker: never a proof of anything. */
export function validateGitFacts(facts: { head: unknown; branch: unknown; git_root: unknown }): boolean {
  const headOk = facts.head === null || (typeof facts.head === "string" && SHA.test(facts.head));
  const branchOk = facts.branch === null || isBoundedName(facts.branch, MAX_BRANCH_CHARS);
  const rootOk = facts.git_root === null || isBoundedName(facts.git_root, MAX_GIT_ROOT_CHARS);
  return headOk && branchOk && rootOk;
}

export type GitRunner = (argv: string[], options: { cwd: string }) => Promise<{ code: number; stdout: string }>;

const bunGitRunner: GitRunner = async (argv, options) => {
  const proc = Bun.spawn(argv, { cwd: options.cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
};

/** Outside a repository (or without git) every fact is null; that is not an error. */
export async function readGitFacts(cwd: string, run: GitRunner = bunGitRunner): Promise<GitFacts> {
  const read = async (args: string[]): Promise<string | null> => {
    try {
      const { code, stdout } = await run(["git", ...args], { cwd });
      const value = stdout.trim();
      return code === 0 && value !== "" ? value : null;
    } catch {
      return null;
    }
  };
  const head = await read(["rev-parse", "HEAD"]);
  const branch = await read(["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitRoot = await read(["rev-parse", "--show-toplevel"]);
  return {
    head: head !== null && SHA.test(head) ? head : null,
    branch: branch === "HEAD" ? null : branch,
    git_root: gitRoot,
  };
}

export interface ContextDepositRequest {
  deposit_capability: string;
  text: string;
  replace?: string | null;
  head: string | null;
  branch: string | null;
  git_root: string | null;
}

export interface ContextDepositMeta {
  deposit_id: string;
  chars: number;
  deposited_at: string;
  head_at_deposit: string | null;
  branch: string | null;
  git_root: string | null;
  state: "held" | "reserved";
}

export interface ContextDepositResponse {
  ok: true;
  deposit_id: string;
  owner_peer_id: string;
  chars: number;
  limit_chars: number;
  deposited_at: string;
  head_at_deposit: string | null;
  branch: string | null;
  state: "held";
  replaced?: string;
  held: Array<Pick<ContextDepositMeta, "deposit_id" | "chars" | "deposited_at">>;
}

export type ContextDepositRefusalReason =
  | "bad_body"
  | "empty_text"
  | "ill_formed_text"
  | "forbidden_characters"
  | "bad_git_fact"
  | "bad_replace_id"
  | "length_required"
  | "capability"
  | "replace_not_found"
  | "contested"
  | "too_long"
  | "body_too_large"
  | "quota_owner"
  | "quota_group"
  | "quota_total";

export interface ContextDepositRefusal {
  error: string;
  reason: ContextDepositRefusalReason;
  max_chars?: number;
  got_chars?: number;
  held_ids?: string[];
}
