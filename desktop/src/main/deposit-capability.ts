import { randomBytes } from 'node:crypto'

/**
 * Same name as the core constant, which the desktop build cannot import; a
 * test pins the two equal. Never rename it with a _TOKEN, _KEY or _SECRET
 * suffix: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB strips those from the agent's Bash.
 */
export const DEPOSIT_CAPABILITY_ENV = 'CLAUDE_PEERS_DEPOSIT_CAPABILITY'

/** A fresh 256-bit capability for one launch, 64 lowercase hex. */
export function mintDepositCapability(): string {
  return randomBytes(32).toString('hex')
}
