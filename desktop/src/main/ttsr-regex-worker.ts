// Deck binding of the isolated regex runner: JS regexes have no execution
// deadline, and one catastrophic pattern on the Electron main process would
// freeze every tile at once. The worker itself lives in the node-only shared
// module, which the rules CLI uses too; this file only supplies the Deck's
// error sink.

import {
  matchIsolated as matchIsolatedShared,
  probeRulesSpeed as probeRulesSpeedShared,
  TTSR_TEST_TIMEOUT_MS,
  type IsolatedMatchResult
} from '../shared/ttsr-probe'
import type { TtsrRule } from '../shared/ttsr-types'
import { reportError } from './log'

export { TTSR_TEST_TIMEOUT_MS, type IsolatedMatchResult }

const onWorkerError = (message: string, e: unknown): void => reportError('ttsr', message, e)

/**
 * First match of `pattern` in each of `texts`, computed in a worker killed
 * after `timeoutMs`. Never rejects: a worker failure comes back as `error`.
 */
export function matchIsolated(
  pattern: string,
  flags: string,
  texts: readonly string[],
  timeoutMs: number = TTSR_TEST_TIMEOUT_MS
): Promise<IsolatedMatchResult> {
  return matchIsolatedShared(pattern, flags, texts, timeoutMs, onWorkerError)
}

/** Adversarial timing gate of a rules file's patterns; errors in the parseRulesFile format. */
export function probeRulesSpeed(rules: readonly TtsrRule[]): Promise<string[]> {
  return probeRulesSpeedShared(rules, { onError: onWorkerError })
}
