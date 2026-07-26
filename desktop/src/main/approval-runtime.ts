// Runtime glue for remote approvals (PLAN-notifications-mobiles N2.c).
//
// Owns the lifecycle index.ts would otherwise carry inline: resolve the
// operator identity, mint ONE restricted credential for the window's agents,
// drop it in a chmod-600 file whose path travels in the child environment, and
// revoke it on shutdown.
//
// WHY ONE CREDENTIAL PER WINDOW, NOT PER TILE. The Deck builds the child
// environment once for every session it spawns (index.ts), so a per-tile
// credential would mean threading a secret through the whole spawn path. It
// buys nothing here: the security property that matters is that NO agent
// credential can settle an approval, and that holds identically at window
// scope. `session_ref` coming from an agent is therefore informational only —
// the verdict of a hook or of ask_operator returns through that same call, and
// the one path that does need a tile id (the attention fallback) is raised by
// the Deck itself, which knows it.
//
// The credential is written to the app-state dir rather than a temp dir so a
// sandbox projection can find it at a stable path.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { generateCredential, deriveTokenId } from './approval-auth'
import { writeFileAtomic } from './atomic-write'
import { loadOperatorIdentity, type OperatorIdentity } from './operator-identity'
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

  /** Dependencies for the operator-signed broker calls. */
  deps(): ApprovalDeps | null {
    if (!this.identity) return null
    return { endpoint: this.opts.endpoint(), identity: this.identity }
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
      const identity = loadOperatorIdentity(this.opts.stateDir, this.opts.cipher)
      if (!identity) {
        reportError(
          'approvals',
          'operator identity unavailable — remote approvals stay off (re-enrol this machine)'
        )
        return false
      }
      this.identity = identity

      const cred = generateCredential()
      const deps: ApprovalDeps = { endpoint: this.opts.endpoint(), identity }
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
          origin: { host: this.opts.host, os_user_hash: identity.osUserHash }
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
