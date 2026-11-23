/** Per-text ceiling of the Skills settings, in UTF-8 bytes: each addendum and the storage text. */
export const SESSION_SKILL_TEXT_MAX_BYTES = 16 * 1024

/**
 * Ceilings of the configured command lines. `args` leaves room for the step
 * token the Deck appends (up to 43 characters) inside the turn signal's
 * 256-character args.
 */
export const SESSION_COMMAND_LIMITS = { linesPerMoment: 8, command: 128, args: 200 } as const

export function sessionSkillTextBytes(text: string): number {
  return new TextEncoder().encode(text).length
}
