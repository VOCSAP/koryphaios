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
import { mintSessionToken, revokeSessionToken, type ApprovalDeps } from './approval-service'
import type { SecretCipher } from './scope-secrets'
import type { BrokerEndpoint } from './broker-client'
import { reportError } from './log'

const CRED_FILE = 'session-approval.json'

export interface ApprovalRuntimeOptions {
  stateDir: string
  cipher: SecretCipher
  endpoint: () => BrokerEndpoint
  /** Stable handle for this window's agents. */
  sessionRef: string
  host: string
  /**
   * The WINDOW's project key (computeDeckProjectKey on its cwd) -- unlike
   * `from_peer`/a tile identity, this is correctly scoped at credential level
   * (card 55c5470e): one window has one project, so writing it here does not
   * mint a singleton keyed by too little the way a per-tile field would.
   * Injected as a function (same shape as `endpoint`) so this module never
   * needs to shell out to git itself. Optional so existing callers/tests that
   * predate card 55c5470e keep compiling; arm() falls back to '' when absent.
   */
  projectKey?: () => string
}

export class ApprovalRuntime {
  private identity: OperatorIdentity | null = null
  private credPath: string | null = null
  private armed = false

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

  /**
   * Turn the feature on: resolve the identity, mint a session credential and
   * publish it. Idempotent. Returns false when it could not arm — the caller
   * should treat that as "the feature is off", never as a fatal error.
   */
  async arm(): Promise<boolean> {
    if (this.armed) return true
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
      // projectKey is resolved once and reused for both the ApprovalDeps
      // literal and the credential's origin.project_key.
      // It is a window property, not a tile identity: a window carries multiple
      // tiles, so writing a tile identity here would be a singleton keyed by
      // too little.
      const projectKey = this.safeProjectKey()
      // projectKey reaches the wire: a resolution failure produces '', which
      // the broker refuses at mint time rather than silently filing an approval
      // nobody's window can see.
      const deps: ApprovalDeps = { endpoint: this.opts.endpoint(), identity, projectKey }
      await mintSessionToken(deps, {
        sessionPublicKey: cred.publicKey,
        sessionRef: this.opts.sessionRef
      })

      const path = join(this.opts.stateDir, CRED_FILE)
      writeFileAtomic(
        path,
        JSON.stringify({
          brokerUrl: this.opts.endpoint().url,
          brokerToken: this.opts.endpoint().token,
          operatorId: identity.operatorId,
          tokenId: deriveTokenId(cred.publicKey),
          sessionRef: this.opts.sessionRef,
          privateKey: cred.privateKey,
          publicKey: cred.publicKey,
          osUserHash: identity.osUserHash,
          origin: { host: this.opts.host, os_user_hash: identity.osUserHash, project_key: projectKey }
        }),
        { mode: 0o600 }
      )
      this.credPath = path
      this.armed = true
      return true
    } catch (e) {
      // Broker down at launch, unwritable state dir: the app must still start,
      // simply without remote approvals.
      reportError('approvals', 'could not arm remote approvals', e)
      return false
    }
  }

  /** Turn it off: revoke broker-side and delete the credential file. */
  async disarm(): Promise<void> {
    const path = this.credPath
    this.credPath = null
    this.armed = false
    if (path) {
      try {
        rmSync(path, { force: true })
      } catch (e) {
        reportError('approvals', 'could not remove the session credential file', e)
      }
    }
    const deps = this.deps()
    if (!deps) return
    try {
      await revokeSessionToken(deps, this.opts.sessionRef)
    } catch (e) {
      // The token expires on its own; a failed revoke is worth a trace, not a
      // blocked shutdown.
      reportError('approvals', 'could not revoke the session credential', e)
    }
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
