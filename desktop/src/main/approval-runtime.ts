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
   * Resolve `opts.projectKey()` without ever throwing (card 4df14b5b review):
   * an absent resolver is benign (existing callers/tests predate project_key
   * and degrade to '' silently), but a SUPPLIED resolver that throws is
   * abnormal and must leave a trace, not propagate past whichever unrelated
   * try/catch happens to be the next one up the stack -- that used to be
   * `arm()`'s OUTER catch (state-dir/keychain failures), which turned a
   * project_key resolution failure into arm() itself returning false. The
   * single accessor is what makes that impossible to reintroduce at either
   * of its two call sites below (arm() resolves it once and reuses the
   * result for both the ApprovalDeps literal and origin.project_key; deps()
   * resolves it separately since it runs at a different time).
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
      // loadOperatorIdentity already mints an identity on first run (no file
      // yet); it returns null only when a file EXISTS but could not be
      // decrypted. That null is NOT proof of corruption on its own -- a
      // locked/unavailable OS keychain produces the exact same null (card
      // 469f3176 review, mutation Q1: a transiently unavailable keychain got
      // treated as "corrupt", destroying the real identity the moment the
      // keychain would otherwise have come back). `cipher.isAvailable()` is
      // the only signal that tells the two apart: only regenerate when the
      // cipher itself is working right now, so the decrypt failure can only
      // be the data, never the keychain being asleep. When it is NOT
      // available, give up arming THIS run rather than guess -- the identity
      // is untouched, and the next arm() (next restart, or a live keychain
      // recheck) gets a clean shot at it.
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
      // Resolved ONCE and reused below for both the ApprovalDeps literal and
      // the credential file's origin.project_key -- safeProjectKey() never
      // throws (card 4df14b5b review): this line runs BEFORE it used to be
      // guarded, so an unprotected call here would have let a throwing
      // resolver escape to arm()'s OUTER catch (state-dir/keychain failures)
      // and turn a project_key failure into arm() itself returning false.
      // project_key is a WINDOW property (one window, one project) so it
      // belongs at credential level. from_peer/a tile identity does NOT: a
      // window carries N tiles, so writing one here would be a singleton
      // keyed by too little (card 55c5470e) -- that resolution happens
      // per-approval, renderer-side, against the live tile that actually
      // raised it. Resolution failure degrades to an empty string, but the
      // two causes are NOT symmetric: an absent projectKey() (existing
      // callers/tests) short-circuits to '' silently, no trace -- that is
      // benign, nothing went wrong. A SUPPLIED projectKey() that throws also
      // degrades to '', but leaves a trace, because that is abnormal and
      // worth knowing about. Neither path ever touches the identity repair
      // above: an absent or failed project_key is benign for the window's
      // approvals, an unwarranted identity rewrite is not.
      const projectKey = this.safeProjectKey()
      // mintSessionToken never lists, so this projectKey never reaches the
      // wire -- required purely to satisfy ApprovalDeps at compile time.
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
 * Arm approvals at Deck startup (card 469f3176). Deliberately its own
 * function, and deliberately taking NO mobileApprovals-shaped argument: the
 * bug this card fixes was index.ts's startup call site being wrapped in
 * `if (config.mobileApprovals)`. A text scan of index.ts only catches the
 * LITERAL spelling of that guard -- rewritten as `=== true`, a ternary, or an
 * inverted early-return, it stays invisible to a scan while the bug is back.
 * This function's signature makes that whole family of rewrites impossible
 * to hide from a test: nothing here CAN branch on mobileApprovals, because
 * mobileApprovals never reaches it. index.ts's whenReady handler must call
 * this directly (see the sibling call site there) with nothing wrapped
 * around it -- the only way left to reintroduce the bug is at that one call
 * site, which desktop-approval-arm-unconditional.test.ts still scans as a
 * second-rung check, per team-lead ruling (this function is the primary
 * proof).
 */
export async function armApprovalsAtStartup(approvals: ApprovalRuntime): Promise<boolean> {
  return approvals.arm()
}
