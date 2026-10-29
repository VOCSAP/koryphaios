// settingsDir must never hold a claude-peers/config.json: loadConfig() reads that file after env.
export function scrubEnv(
  settingsDir: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  // extra winning last (below) is a real override path, not just a leftover
  // ordering: refuse the one shape it must never carry, extra reinjecting the
  // REAL ambient value of the var it exists to neutralize. Only compares when
  // extra explicitly SETS the key: an unset ambient var (e.g. APPDATA on a
  // non-Windows CI runner) and an absent extra key are both undefined, and
  // that pairing must never be read as reinjection.
  for (const k of ["APPDATA", "XDG_CONFIG_HOME", "HOME", "USERPROFILE"] as const) {
    const ambient = process.env[k];
    if (ambient !== undefined && Object.prototype.hasOwnProperty.call(extra, k) && extra[k] === ambient) {
      throw new Error(`scrubEnv: extra.${k} re-injects the real ambient ${k}; pass a scratch directory instead`);
    }
  }
  // DECK_CONTROL_* too: a supervisor or team-lead tile running the tests holds
  // a live Deck control URL and token that no child may inherit.
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("CLAUDE_PEERS_") &&
        !k.toUpperCase().startsWith("DECK_CONTROL_") &&
        k !== "CLAUDE_CODE_MESSAGING_SOCKET"
    )
  ) as Record<string, string>;
  return {
    ...scrubbed,
    APPDATA: settingsDir,
    XDG_CONFIG_HOME: settingsDir,
    HOME: settingsDir,
    USERPROFILE: settingsDir,
    ...extra,
  };
}
