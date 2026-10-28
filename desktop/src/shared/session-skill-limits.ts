/** Per-text ceiling of the Skills settings, in UTF-8 bytes: each addendum and the storage text. */
export const SESSION_SKILL_TEXT_MAX_BYTES = 16 * 1024

export function sessionSkillTextBytes(text: string): number {
  return new TextEncoder().encode(text).length
}
