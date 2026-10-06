import type { On } from './claude-code-types.ts'
import { register as registerApprovals } from './kory-approvals.ts'
import { register as registerTelemetry } from './kory-telemetry.ts'

export function register(on: On): void {
  registerTelemetry(on)
  registerApprovals(on)
}
