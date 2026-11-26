export interface EnvIntRule {
  min: number;
  max: number;
  fallback: number;
  /** What an integer under `min` becomes; every other unusable value becomes `fallback`. */
  belowMin: "min" | "fallback";
}

/**
 * A bounded integer read from an environment value, for durations that feed a
 * timer: a NaN or a delay above 2^31 ms makes the timer fire every millisecond.
 * An unset variable is the fallback; any other value that is not used as written
 * is reported through `warn`.
 */
export function envInt(
  name: string,
  raw: string | undefined,
  rule: EnvIntRule,
  warn: (message: string, context: { value: string }) => void
): number {
  if (raw === undefined) return rule.fallback;
  // Number("") is 0, which a "min" rule would turn into the floor instead of the default.
  const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
  const integer = Number.isSafeInteger(parsed);
  if (integer && parsed >= rule.min && parsed <= rule.max) return parsed;
  const used = integer && parsed < rule.min && rule.belowMin === "min" ? rule.min : rule.fallback;
  warn(`${name} is not an integer between ${rule.min} and ${rule.max}, using ${used}`, { value: raw });
  return used;
}
