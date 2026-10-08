// Mints one restricted credential per window, not per tile: the property that
// matters is that no agent credential can settle an approval, which holds
// identically at window scope without threading a secret through every spawn.
// `session_ref` from an agent is informational only; the verdict returns
// through the same call.
// The credential file lives in the app-state dir, not a temp dir, so a sandbox
// projection can find it at a stable path.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { generateCredential, deriveTokenId } from './approval-auth'
import { writeFileAtomic } from './atomic-write'
import { loadOperatorIdentity, createOperatorIdentity, type OperatorIdentity } from './operator-identity'
import { mintSessionToken, renewSessionToken, revokeSessionToken, type ApprovalDeps } from './approval-service'
import { teamLeadInstanceToken } from './team-lead-mcp-sweep'
import type { SecretCipher } from './scope-secrets'
import type { BrokerEndpoint } from './broker-client'
import { reportError } from './log'

const CRED_FILE = 'session-approval.json'
const RENEWAL_INTERVAL_MS = 6 * 3600_000

export function approvalCredFileName(projectKey: string, runId: string): string {
  return `${teamLeadInstanceToken(projectKey)}-${runId}-${CRED_FILE}`
}

export interface ApprovalRuntimeOptions {
  stateDir: string
  cipher: SecretCipher
  endpoint: () => BrokerEndpoint
  runId: string
  host: string
  /** Injected so this module does not resolve the window project through git. */
  projectKey?: () => string
  renewalIntervalMs?: number
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (timer: unknown) => void
}

export class ApprovalRuntime {
  private identity: OperatorIdentity | null = null
  private credPath: string | null = null
  private tokenId: string | null = null
  private armed = false
  private generation = 0
  private closed = false
  private disarming = false
  private armInFlight: Promise<boolean> | null = null
  private disarmInFlight: Promise<void> | null = null
  private renewal: { publicKey: string; sessionRef: string; projectKey: string; expiresAt: string } | null = null
  private renewalTimer: unknown | null = null
  private renewalAbort: AbortController | null = null
  private renewalInFlight: Promise<void> | null = null

  constructor(private readonly opts: ApprovalRuntimeOptions) {}

  /** Identity of the operator running this window, or null if unavailable. */
  get operator(): OperatorIdentity | null {
    return this.identity
  }

  /**
   * Never throws: an absent resolver degrades to '' silently, but a supplied
   * resolver that throws is reported rather than propagating into arm()'s outer
   * catch, which would otherwise turn a project_key failure into arm()
   * returning false.
   */
  private safeProjectKey(): string {
    try {
      return this.opts.projectKey?.() ?? ''
    } catch (e) {
      reportError(
        'approvals',
        `project_key resolution failed, leaving it empty — ${e instanceof Error ? e.message : String(e)}`
      )
      return ''
    }
  }

  /** Dependencies for the operator-signed broker calls. */
  deps(): ApprovalDeps | null {
    if (!this.identity) return null
    // Same resolver as arm()'s origin.project_key below (card 4df14b5b):
    // ApprovalDeps.projectKey is what fetchPendingApprovals/
    // fetchUndeliveredVerdicts now send on every /approval/list call, so this
    // window reads back only the approvals it could have raised. An absent
    // resolver degrades to '', same as arm() -- the broker is what then
    // refuses it loudly, not this getter.
    return { endpoint: this.opts.endpoint(), identity: this.identity, projectKey: this.safeProjectKey() }
  }

  /** Env vars merged into every spawned session. Empty when disarmed. */
  env(): Record<string, string> {
    // Always emit the key so a value inherited from the parent process cannot
    // silently re-enable the feature in a session (same neutralisation rule as
    // the forced-group transport in scope.ts).
    return { CLAUDE_PEERS_APPROVAL_FILE: this.armed && this.credPath ? this.credPath : '' }
  }

  private async revokeStoredToken(): Promise<boolean> {
    const tokenId = this.tokenId
    if (!tokenId) return true
    const deps = this.deps()!
    try {
      await revokeSessionToken(deps, tokenId)
      this.tokenId = null
      return true
    } catch (e) {
      reportError('approvals', 'could not revoke the session credential', e)
      return false
    }
  }

  private isCurrentArm(generation: number): boolean {
    return !this.closed && !this.disarming && this.generation === generation
  }

  private stopRenewal(): void {
    if (this.renewalTimer !== null) {
      if (this.opts.clearTimeout) this.opts.clearTimeout(this.renewalTimer)
      else clearTimeout(this.renewalTimer as ReturnType<typeof setTimeout>)
      this.renewalTimer = null
    }
    this.renewalAbort?.abort()
    this.renewalAbort = null
    this.renewalInFlight = null
    this.renewal = null
  }

  private canRenew(generation: number, renewal: { publicKey: string; sessionRef: string; projectKey: string; expiresAt: string }): boolean {
    return this.isCurrentArm(generation) && this.armed && this.renewal === renewal && this.now() < Date.parse(renewal.expiresAt)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private renewalExpiry(expiresAt: unknown): string | null {
    if (typeof expiresAt !== 'string') return null
    const timestamp = Date.parse(expiresAt)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== expiresAt || timestamp <= this.now()) return null
    return expiresAt
  }

  private scheduleRenewal(generation: number): void {
    const renewal = this.renewal
    if (!renewal || !this.canRenew(generation, renewal)) return
    let timer: unknown
    const callback = () => {
      if (this.renewalTimer === timer) this.renewalTimer = null
      void this.renew(generation, renewal)
    }
    const delayMs = this.opts.renewalIntervalMs ?? RENEWAL_INTERVAL_MS
    timer = this.opts.setTimeout ? this.opts.setTimeout(callback, delayMs) : setTimeout(callback, delayMs)
    this.renewalTimer = timer
  }

  private async renew(generation: number, renewal: { publicKey: string; sessionRef: string; projectKey: string; expiresAt: string }): Promise<void> {
    if (!this.canRenew(generation, renewal) || this.renewalInFlight) return
    const controller = new AbortController()
    this.renewalAbort = controller
    const pending = this.renewGeneration(generation, renewal, controller.signal)
    this.renewalInFlight = pending
    try {
      await pending
    } finally {
      if (this.renewalInFlight === pending) this.renewalInFlight = null
      if (this.renewalAbort === controller) this.renewalAbort = null
    }
  }

  private async renewGeneration(
    generation: number,
    renewal: { publicKey: string; sessionRef: string; projectKey: string; expiresAt: string },
    signal: AbortSignal
  ): Promise<void> {
    try {
      if (!this.identity) return
      const response = await renewSessionToken({
        endpoint: this.opts.endpoint(),
        identity: this.identity,
        projectKey: renewal.projectKey
      }, {
        sessionPublicKey: renewal.publicKey,
        sessionRef: renewal.sessionRef,
        signal
      })
      if (!this.canRenew(generation, renewal)) return
      const expiresAt = this.renewalExpiry(response.expires_at)
      if (!expiresAt) {
        reportError('approvals', 'broker returned an invalid approval token expiry; renewal is disabled for this run')
        return
      }
      renewal.expiresAt = expiresAt
      this.scheduleRenewal(generation)
    } catch (e) {
      if (signal.aborted) return
      reportError('approvals', 'could not renew the session credential', e)
      if (this.canRenew(generation, renewal)) this.scheduleRenewal(generation)
    }
  }

  /**
   * Turn the feature on: resolve the identity, mint a session credential and
   * publish it. Concurrent callers share one operation. Returns false when it
   * could not arm so callers can keep the feature off.
   */
  async arm(): Promise<boolean> {
    if (this.closed || this.disarming) return false
    if (this.armed) return true
    if (this.armInFlight) return this.armInFlight

    const generation = ++this.generation
    const pending = this.armGeneration(generation)
    this.armInFlight = pending
    try {
      return await pending
    } finally {
      if (this.armInFlight === pending) this.armInFlight = null
    }
  }

  private async armGeneration(generation: number): Promise<boolean> {
    if (!(await this.revokeStoredToken())) return false
    if (!this.isCurrentArm(generation)) return false

    try {
      if (!existsSync(this.opts.stateDir)) mkdirSync(this.opts.stateDir, { recursive: true })
      // loadOperatorIdentity returning null does not by itself mean corruption:
      // a locked or unavailable OS keychain produces the same null.
      // Only regenerate the identity when cipher.isAvailable() confirms the
      // cipher itself is working; otherwise leave the identity untouched and
      // let a later arm() retry.
      let identity = loadOperatorIdentity(this.opts.stateDir, this.opts.cipher)
      if (!identity) {
        if (!this.opts.cipher.isAvailable()) {
          reportError(
            'approvals',
            'operator identity unreadable because the keychain is unavailable right now — remote approvals stay off until it returns (not regenerating: that would destroy the real identity and orphan pending approvals / phone pairings under the old operator id)'
          )
          return false
        }
        reportError(
          'approvals',
          'operator identity was unreadable — regenerating (this machine will re-enrol under a new operator id; the old identity file is kept as a .bak, never deleted)'
        )
        identity = createOperatorIdentity(this.opts.stateDir, this.opts.cipher, generateCredential())
      }
      this.identity = identity

      const cred = generateCredential()
      const projectKey = this.safeProjectKey()
      const sessionRef = `window-${this.opts.runId}`
      const tokenId = deriveTokenId(cred.publicKey)
      const deps: ApprovalDeps = { endpoint: this.opts.endpoint(), identity, projectKey }
      const minted = await mintSessionToken(deps, {
        sessionPublicKey: cred.publicKey,
        sessionRef
      })
      this.tokenId = tokenId
      if (!this.isCurrentArm(generation)) {
        await this.revokeStoredToken()
        return false
      }

      const path = join(this.opts.stateDir, approvalCredFileName(projectKey, this.opts.runId))
      writeFileAtomic(
        path,
        JSON.stringify({
          brokerUrl: this.opts.endpoint().url,
          brokerToken: this.opts.endpoint().token,
          operatorId: identity.operatorId,
          tokenId,
          sessionRef,
          privateKey: cred.privateKey,
          publicKey: cred.publicKey,
          osUserHash: identity.osUserHash,
          origin: { host: this.opts.host, os_user_hash: identity.osUserHash, project_key: projectKey }
        }),
        { mode: 0o600 }
      )
      this.credPath = path
      this.armed = true
      if (minted.capabilities?.renew_only === true) {
        const expiresAt = this.renewalExpiry(minted.expires_at)
        if (expiresAt) {
          this.renewal = { publicKey: cred.publicKey, sessionRef, projectKey, expiresAt }
          this.scheduleRenewal(generation)
        } else {
          reportError('approvals', 'broker returned an invalid approval token expiry; renewal is disabled for this run')
        }
      } else {
        reportError('approvals', 'broker does not support approval token renewal; renewal is disabled for this run')
      }
      return true
    } catch (e) {
      // Broker down at launch, unwritable state dir: the app must still start,
      // simply without remote approvals.
      reportError('approvals', 'could not arm remote approvals', e)
      await this.revokeStoredToken()
      return false
    }
  }

  async disarm(): Promise<void> {
    if (this.disarmInFlight) return this.disarmInFlight

    this.disarming = true
    this.generation += 1
    this.armed = false
    this.stopRenewal()
    const pending = this.finishDisarm()
    this.disarmInFlight = pending
    try {
      await pending
    } finally {
      if (this.disarmInFlight === pending) this.disarmInFlight = null
      this.disarming = false
    }
  }

  /** Stops approval arming permanently while the process exits. */
  async close(): Promise<void> {
    this.closed = true
    await this.disarm()
  }

  private async finishDisarm(): Promise<void> {
    await this.armInFlight

    const path = this.credPath
    this.credPath = null
    if (path) {
      try {
        rmSync(path, { force: true })
      } catch (e) {
        reportError('approvals', 'could not remove the session credential file', e)
      }
    }
    await this.revokeStoredToken()
  }
}

/**
 * Deliberately takes no mobileApprovals-shaped argument: nothing in this
 * function can branch on that flag, so wrapping the call site in a conditional
 * is the only way left to gate it, which that call site's own test scans for.
 */
export async function armApprovalsAtStartup(approvals: ApprovalRuntime): Promise<boolean> {
  return approvals.arm()
}
