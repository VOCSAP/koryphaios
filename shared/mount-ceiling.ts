// Mount ceilings: the tool sets the Deck grants to a kory-deck or kory-operator
// process. They are written by the Deck into the env of the generated MCP
// config entry, so unlike CLAUDE_PEERS_TOOLS (a per-session filter whose
// absence means "no restriction") an absent or malformed ceiling serves nothing.

export const OPERATOR_TOOLS = [
  "ask_operator",
  "ask_operator_wait",
  "notify_operator",
  "graph_draft_prepare",
  "graph_draft_send",
] as const;

export const OPERATOR_CEILING_ENV = "KORY_OPERATOR_TOOLS";
export const DECK_CEILING_ENV = "DECK_CONTROL_TOOLS";
export const DECK_ROLE_ENV = "DECK_CONTROL_ROLE";

export const DECK_ROLES = ["supervisor", "lead"] as const;
export type DeckRole = (typeof DECK_ROLES)[number];

/** An empty env value reaches a Windows child as an absent variable, so the empty set has its own spelling. */
const EMPTY_SET = "none";

export type Resolution<T> = { ok: true; value: T } | { ok: false; reason: string };

export function encodeMountCeiling(tools: readonly string[]): string {
  return tools.length > 0 ? tools.join(",") : EMPTY_SET;
}

/**
 * Exact names only, no trimming: the Deck is the sole author of the value, so
 * an entry that is not a registry name is a defect and refuses the whole set.
 */
export function resolveMountCeiling(
  envName: string,
  raw: string | undefined,
  registry: readonly string[]
): Resolution<string[]> {
  if (raw === undefined || raw === "") return { ok: false, reason: `${envName} is not set` };
  if (raw === EMPTY_SET) return { ok: true, value: [] };
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    if (entry === "") return { ok: false, reason: `${envName} has an empty entry` };
    if (!registry.includes(entry)) return { ok: false, reason: `${envName} names unknown tool '${entry.slice(0, 64)}'` };
    if (seen.has(entry)) return { ok: false, reason: `${envName} lists '${entry}' twice` };
    seen.add(entry);
  }
  return { ok: true, value: [...seen] };
}

export function resolveMountRole(raw: string | undefined): Resolution<DeckRole> {
  const role = DECK_ROLES.find((candidate) => candidate === raw);
  if (role === undefined) {
    return { ok: false, reason: `${DECK_ROLE_ENV} is ${raw === undefined || raw === "" ? "not set" : "not a known role"}` };
  }
  return { ok: true, value: role };
}
