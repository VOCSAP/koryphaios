export const TOOLS_ENV_VAR = "CLAUDE_PEERS_TOOLS";

export function resolveToolAllowlist(envValue: string | undefined): string[] | null {
  if (envValue === undefined) return null;
  if (envValue === "") return [];
  return envValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function filterTools<T extends { name: string }>(tools: readonly T[], allowlist: string[] | null): T[] {
  if (allowlist === null) return tools.slice();
  const allowed = new Set(allowlist);
  return tools.filter((tool) => allowed.has(tool.name));
}
