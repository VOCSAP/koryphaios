import type { On } from './claude-code-types.ts'
import { register as registerApprovals } from './kory-approvals.ts'
import { register as registerTelemetry } from './kory-telemetry.ts'
import { register as registerTurns } from './kory-turns.ts'

export function register(on: On): void {
  registerTelemetry(on)
  registerApprovals(on)
  registerTurns(on)
}
