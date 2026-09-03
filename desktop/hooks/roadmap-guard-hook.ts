// Refuses a roadmap_add/update/append_context call whose text arguments carry
// the literal tag markup of another argument (a serialization accident), before
// it reaches the broker.
// Detects the field's own closing tag (either </fieldName> or the generic
// </parameter>, both real serialization forms) immediately followed by another
// parameter's opening tag — a citation never carries a closing tag it would
// also have to quote and escape, which is exactly the accident.
// Matcher names the MCP tools explicitly rather than using an empty matcher
// plus internal filtering, since an empty matcher would spawn this process on
// every tool call in the session.
// Fails open: any internal error exits 0 with no decision, so a bug here never
// blocks a legitimate roadmap write.

/** Free-text fields this hook inspects, per MCP tool. Extending coverage to
 * a future roadmap tool that writes long free text means adding BOTH an
 * entry here AND a matching PreToolUse entry in hooks.json naming that
 * tool -- this list alone does not make the hook fire on it. */
const TOOL_TEXT_FIELDS: Record<string, readonly string[]> = {
  "mcp__claude-peers__roadmap_add": ["title", "description", "rationale", "context"],
  "mcp__claude-peers__roadmap_update": ["title", "description", "rationale", "context"],
  "mcp__claude-peers__roadmap_append_context": ["text"],
};

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface AccidentMatch {
  /** The field whose value carries the stray tag pair. */
  field: string;
  /** The field name the opening tag names -- may be anything, including a
   * non-text field (tags, priority, ...) or a name this tool doesn't even
   * have. The pair alone is the signal; the target's identity is not. */
  targetField: string;
  /** The literal closing-tag spelling that actually matched: either the
   * semantic `</field>` form or the generic `</parameter>` form (card
   * 0e28cb4e). Used verbatim in the refusal message's remedy so it names
   * the tag actually present in the caller's text, not an assumed one. */
  closingTag: string;
  /** The exact matched text (closing tag + opening tag), verbatim, for the
   * refusal message. */
  matchedTag: string;
}

/**
 * Scans every text field this tool call carries for ITS OWN closing tag
 * immediately followed by another parameter's opening tag --
 * `</field>...<parameter name="X">`. That pair is the accident's signature:
 * content for two parameters landed in one, split exactly where a real
 * parameter boundary would have been. A citation of the syntax never
 * carries the closing tag of the field it lives in (see file header).
 * Returns the first match, or null when nothing matches.
 */
export function detectSerializationAccident(
  toolName: string,
  toolInput: Record<string, unknown> | undefined
): AccidentMatch | null {
  const fields = TOOL_TEXT_FIELDS[toolName];
  if (!fields || !toolInput) return null;

  for (const field of fields) {
    const value = toolInput[field];
    if (typeof value !== "string" || value === "") continue;

    // Field names are our own static list, never operator input, so
    // interpolating them into a RegExp here is safe — nothing needs escaping.
    const closeThenOpenRe = new RegExp(
      `(</${field}>|</parameter>)\\s*<parameter\\s+name\\s*=\\s*"([a-zA-Z0-9_]+)"\\s*>`
    );
    const match = closeThenOpenRe.exec(value);
    if (match) {
      return { field, targetField: match[2]!, closingTag: match[1]!, matchedTag: match[0] };
    }
  }
  return null;
}

/** Refusal text. Describes what was OBSERVED (the field, the exact tag
 * pair), never a hypothesis about the mechanism that produced it. Gives
 * TWO distinct remedies rather than one, because they are not
 * interchangeable: "fill every field" would tell an agent recovering from
 * a genuine accident to do the right thing, but told to a `roadmap_update`
 * caller who is legitimately quoting the syntax in a partial update, it
 * prescribes overwriting every other field of the card with improvised
 * filler -- `roadmap_update` only changes the fields you pass, and
 * `context` replacement is exactly why `roadmap_append_context` exists.
 * Never tell the caller to fill fields it did not intend to touch. */
export function buildRefusalReason(m: AccidentMatch): string {
  // The remedy names the tag SPELLING that actually matched (`</field>` or
  // the generic `</parameter>`, card 0e28cb4e) -- not an assumed
  // `</${field}>`, which would be a wrong instruction on the generic form
  // (the caller's text does not contain that literal tag to break).
  const brokenClosingTag = `< ${m.closingTag.slice(1)}`;
  return [
    `roadmap-guard: field "${m.field}" contains ${m.matchedTag}, right where "${m.field}" itself should have ended.`,
    `That is this field's own closing tag followed by another parameter's opening tag -- content for two parameters landed in one.`,
    `If this is accidental: split the content of "${m.field}" back into the parameters it was meant for, and resend.`,
    `If you are quoting this markup on purpose: break the closing tag itself, e.g. write "${brokenClosingTag}" with a space, then resend.`,
  ].join(" ");
}

export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

/** Build the stdout decision for a PreToolUse payload, or null for no
 * decision (falls through to the normal permission flow). */
export function buildDecision(payload: HookPayload): Record<string, unknown> | null {
  if (payload.hook_event_name !== "PreToolUse") return null;
  const toolName = payload.tool_name ?? "";
  // Object.hasOwn, not `toolName in TOOL_TEXT_FIELDS`: `in` walks the
  // prototype chain, so a tool_name of "toString" or "constructor" would
  // resolve to a Function and throw inside detectSerializationAccident
  // (caught by main()'s fail-open, but by accident, not by a real check).
  if (!Object.hasOwn(TOOL_TEXT_FIELDS, toolName)) return null;

  const m = detectSerializationAccident(toolName, payload.tool_input);
  if (!m) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: buildRefusalReason(m),
    },
  };
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  const payload = parseHookPayload(await readStdin());
  const decision = buildDecision(payload);
  if (decision) process.stdout.write(JSON.stringify(decision));
  // No decision -> no stdout, exit 0: normal permission flow applies.
}

if (import.meta.main) {
  // Fail open: an internal error (bad stdin, unexpected shape) must never
  // block the team's roadmap. A bug in this guard is not a reason to stop
  // everyone else from writing roadmap cards.
  void main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
