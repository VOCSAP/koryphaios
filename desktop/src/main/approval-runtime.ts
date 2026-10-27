// Mints one restricted credential per window, not per tile: the property that
// matters is that no agent credential can settle an approval, which holds
// identically at window scope without threading a secret through every spawn.
// `session_ref` from an agent is informational only; the verdict returns
// through the same call.
// The credential file lives in the app-state dir, not a temp dir, so a sandbox
// projection can find it at a stable path.

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { generateCredential, deriveTokenId } from './approval-auth'
import { writeFileAtomic } from './atomic-write'
import { ensureOperatorIdentity, type OperatorIdentity } from './operator-identity'
import {
  BrokerHttpError,
  checkOperatorTrust,
  mintSessionToken,
  renewSessionToken,
  revokeSessionToken,
  type ApprovalDeps,
  type ApprovalTokenInboxBlock,
  type InboxAuthority,
  type OperatorTrustStatus
} from './approval-service'
import { teamLeadInstanceToken } from './team-lead-mcp-sweep'
import type { SecretCipher } from './scope-secrets'
import type { BrokerEndpoint } from './broker-client'
import { reportError } from './log'

const CRED_FILE = 'session-approval.json'
const RENEWAL_INTERVAL_MS = 6 * 3600_000

export function approvalCredFileName(projectKey: string, runId: string, groupId = ''): string {
  const group = groupId ? `-${groupId}` : ''
  return `${teamLeadInstanceToken(projectKey)}-${runId}${group}-${CRED_FILE}`
}

export type ScopeRefusalCause =
  | 'trust'
  | 'identity'
  | 'capability'
  | 'local-file'
  | 'mint-refused'
  | 'busy'
  | 'closed'
  | 'invalid-target'

export interface ScopeTarget {
  projectKey: string
  groupId: string
}

export type PublishedRootStatus = 'ready' | 'pending' | 'missing'

export interface ReadyRootPreparation {
  state: 'ready'
  target: Readonly<ScopeTarget>
  canPublish(): boolean
  install(): RootPreparation
  publish(): void
  abandon(): Promise<void>
}

export interface RefusedRootPreparation {
  state: 'refused'
  cause: ScopeRefusalCause
  abandon(): Promise<void>
}

export type RootPreparation = ReadyRootPreparation | RefusedRootPreparation

interface Renewal {
  publicKey: string
  sessionRef: string
  projectKey: string
  expiresAt: string
  inbox: ApprovalTokenInboxBlock
}

/** The run credential currently published; a new object per arm, so a stale reference is detectable. */
interface RunRoot {
  tokenId: string
  deps: ApprovalDeps
  runRef: string
  groupId: string
  expiresAt: string
}

interface RootDebt {
  tokenId: string
  deps: ApprovalDeps
}

interface PreparedRoot {
  target: Readonly<ScopeTarget>
  identity: OperatorIdentity
  debt: RootDebt
  runRef: string
  inbox: Extract<ApprovalTokenInboxBlock, { kind: 'run' }>
  publicPath: string
  privatePath: string
  publicKey: string
  expiresAt: string
  renewal: Renewal | null
  supportsRenewal: boolean
  installed: boolean
  published: boolean
  generation: number
}

export type MandateState =
  | { state: 'pending' }
  | { state: 'refused' }
  | { state: 'ready'; tokenId: string; publicKey: string; privateKey: string; expiresAt: string }

interface MandateEntry {
  authority: InboxAuthority
  status: MandateState
  /** Bumped by every mint attempt: only the latest attempt may publish. */
  attempt: number
  sessionRef: string
  /** The root a ready mandate hangs from; renewals and revocations go through it. */
  root: RunRoot | null
}

export interface ApprovalRuntimeOptions {
  stateDir: string
  cipher: SecretCipher
  endpoint: () => BrokerEndpoint
  runId: string
  host: string
  /** Injected so this module does not resolve the window project through git. */
  projectKey?: () => string
  /** The window's active group: the run credential is minted for exactly this group. */
  groupId: () => string
  renewalIntervalMs?: number
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (timer: unknown) => void
  onTrustStatus?: (status: OperatorTrustStatus | 'identity-unreadable', publicKey?: string) => void
}

export class ApprovalRuntime {
  private identity: OperatorIdentity | null = null
  private credPath: string | null = null
  private debt: RootDebt | null = null
  private preparation: PreparedRoot | null = null
  private preparing = false
  private armed = false
  private generation = 0
  private closed = false
  private disarming = false
  private armInFlight: Promise<boolean> | null = null
  private retryInFlight: Promise<boolean> | null = null
  private disarmInFlight: Promise<void> | null = null
  private renewal: Renewal | null = null
  private renewalTimer: unknown | null = null
  private renewalAbort: AbortController | null = null
  private renewalInFlight: Promise<void> | null = null
  private readonly preparationWaiters = new Set<() => void>()
  private reportedRefusal: OperatorTrustStatus | null = null
  private root: RunRoot | null = null
  private mandateRenewalAbort: AbortController | null = null
  // Keyed by the deck-control callerId, which carries a random suffix: two
  // callers sharing a label are two entries and two broker tokens.
  private readonly mandates = new Map<string, MandateEntry>()

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
    return {
      endpoint: this.opts.endpoint(),
      identity: this.identity,
      projectKey: this.safeProjectKey(),
      runRef: this.runRef()
    }
  }

  private runRef(): string {
    return this.opts.runId.toLowerCase()
  }

  inboxRun():{ runRef: string; groupId: string } | null {
    if (!this.armed || !this.root) return null
    return { runRef: this.root.runRef, groupId: this.root.groupId }
  }

  publishedRootStatus(target: ScopeTarget): PublishedRootStatus {
    if (this.root && this.root.deps.projectKey === target.projectKey && this.root.groupId === target.groupId && this.now() < Date.parse(this.root.expiresAt)) return 'ready'
    return this.preparing || this.preparation || this.debt ? 'pending' : 'missing'
  }

  whenPreparationSettled(signal?: AbortSignal): Promise<void> {
    if (this.closed || this.disarming || (!this.preparing && !this.preparation)) return Promise.resolve()
    return new Promise((resolve) => {
      const settle = (): void => {
        signal?.removeEventListener('abort', settle)
        this.preparationWaiters.delete(settle)
        resolve()
      }
      this.preparationWaiters.add(settle)
      signal?.addEventListener('abort', settle, { once: true })
      if (signal?.aborted || this.closed || this.disarming || (!this.preparing && !this.preparation)) settle()
    })
  }

  private settlePreparationWaiters(force = false): void {
    if (!force && (this.preparing || this.preparation)) return
    for (const settle of this.preparationWaiters) settle()
  }

  /**
   * Re-runs the trust handshake against the broker answering now: the verdict
   * reached by arm() does not survive a broker respawned or adopted after an
   * outage. A failed request rejects without publishing, so a transient outage
   * never pins the banner.
   */
  private async requestTrust(): Promise<{ trust: OperatorTrustStatus; identity: OperatorIdentity }> {
    const deps = this.deps()
    if (!deps) throw new Error('operator identity is unavailable for the operator trust check')
    return { trust: await checkOperatorTrust(deps), identity: deps.identity }
  }

  async checkTrustNow(): Promise<OperatorTrustStatus> {
    const { trust, identity } = await this.requestTrust()
    if (trust !== 'unreachable') this.publishTrust(trust, identity)
    if (trust === 'compatible') this.reportedRefusal = null
    return trust
  }

  async retryTrust(): Promise<boolean> {
    if (this.closed || this.disarming) return false
    if (this.retryInFlight) return this.retryInFlight

    const pending = this.retryTrustNow()
    this.retryInFlight = pending
    try {
      return await pending
    } finally {
      if (this.retryInFlight === pending) this.retryInFlight = null
    }
  }

  private async retryTrustNow(): Promise<boolean> {
    if (!this.armed) return this.arm()

    const generation = this.generation
    const identity = this.identity
    try {
      const trust = await this.requestTrust()
      if (!this.isCurrentArm(generation) || !this.armed) return false
      if (trust.trust !== 'unreachable') this.publishTrust(trust.trust, trust.identity)
      this.reportTrustRefusal(trust.trust)
      return true
    } catch (e) {
      reportError('approvals', 'could not recheck operator trust', e)
      if (identity && this.isCurrentArm(generation) && this.armed) {
        this.opts.onTrustStatus?.('unreachable', identity.publicKey)
      }
      return false
    }
  }

  private publishTrust(trust: OperatorTrustStatus, identity: OperatorIdentity): void {
    this.opts.onTrustStatus?.(trust, identity.publicKey)
  }

  /** Reports a refusal once per distinct refused state; a compatible answer re-arms the report. */
  private reportTrustRefusal(trust: OperatorTrustStatus): void {
    if (trust === 'compatible') {
      this.reportedRefusal = null
      return
    }
    if (trust === 'unreachable' || trust === this.reportedRefusal) return
    this.reportedRefusal = trust
    reportError('approvals', `broker refused operator trust (${trust}); remote approvals are unavailable`)
  }

  /** Env vars merged into every spawned session. Empty when disarmed. */
  env(): Record<string, string> {
    const path = this.armed ? this.credPath : null
    return { CLAUDE_PEERS_APPROVAL_FILE: path ?? '' }
  }

  private async revokeDebt(debt: RootDebt | null = this.debt): Promise<boolean> {
    if (!debt) return true
    try {
      const result = await revokeSessionToken(debt.deps, debt.tokenId)
      if (result.revoked < 1) {
        reportError('approvals', 'session credential revocation is not confirmed; minting remains blocked')
        return false
      }
      if (this.debt === debt) this.debt = null
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
    this.mandateRenewalAbort?.abort()
    this.mandateRenewalAbort = null
    this.renewalInFlight = null
    this.renewal = null
  }

  private canRenew(generation: number, renewal: Renewal): boolean {
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

  private async renew(generation: number, renewal: Renewal): Promise<void> {
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
    renewal: Renewal,
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
        inbox: renewal.inbox,
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
      // A child is never prolonged by its parent's renewal: each mandate is
      // renewed on its own, after the parent succeeded, and a silent broker on
      // a child never holds the parent's next renewal.
      if (this.root) this.startMandateRenewals(this.root)
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
    const preparation = await this.prepareScope({ projectKey: this.safeProjectKey(), groupId: this.safeGroupId() }, generation, true)
    if (preparation.state === 'refused') return false
    const installed = preparation.install()
    if (installed.state === 'refused') {
      await installed.abandon()
      return false
    }
    installed.publish()
    return true
  }

  async recoverPublishedScope(target: ScopeTarget): Promise<boolean> {
    if (this.closed || this.disarming || this.debt || this.preparing || this.preparation) return false
    if (this.publishedRootStatus(target) === 'ready') return true
    const preparation = await this.prepareScope(target)
    if (preparation.state === 'refused') return false
    const installed = preparation.install()
    if (installed.state === 'refused') {
      await installed.abandon()
      return false
    }
    installed.publish()
    return true
  }

  async prepareScope(target: ScopeTarget, generation?: number, allowEmptyProject = false): Promise<RootPreparation> {
    const snapshot = Object.freeze({ projectKey: target.projectKey, groupId: target.groupId })
    if (this.closed) return this.refusedPreparation('closed')
    if (this.disarming || this.preparation || this.preparing) return this.refusedPreparation('busy')
    if (!snapshot.groupId || (!allowEmptyProject && !snapshot.projectKey)) return this.refusedPreparation('invalid-target')
    const currentGeneration = generation ?? ++this.generation
    this.preparing = true
    try {
      let endpoint: ReturnType<ApprovalRuntimeOptions['endpoint']>
      try {
        endpoint = { ...this.opts.endpoint() }
      } catch (e) {
        reportError('approvals', 'could not resolve the broker endpoint before preparing a scope', e)
        return this.refusedPreparation('trust')
      }
      return await this.prepareSnapshot(snapshot, endpoint, currentGeneration)
    } finally {
      this.preparing = false
      this.settlePreparationWaiters()
    }
  }

  private async prepareSnapshot(target: Readonly<ScopeTarget>, endpoint: ReturnType<ApprovalRuntimeOptions['endpoint']>, generation: number): Promise<RootPreparation> {
    this.unpublishRoot()
    if (!(await this.revokeDebt()) || !this.isCurrentArm(generation)) return this.refusedPreparation('mint-refused')

    if (!existsSync(this.opts.stateDir)) mkdirSync(this.opts.stateDir, { recursive: true })
    const identityResult = ensureOperatorIdentity(this.opts.stateDir, this.opts.cipher)
    if (identityResult.state !== 'ready') {
      this.identity = null
      this.opts.onTrustStatus?.('identity-unreadable')
      reportError('approvals', 'operator identity is unavailable; remote approvals stay off')
      return this.refusedPreparation('identity')
    }
    const identity = identityResult.identity
    const deps: ApprovalDeps = { endpoint, identity, projectKey: target.projectKey }
    let trust: OperatorTrustStatus
    try {
      trust = await checkOperatorTrust(deps)
    } catch (e) {
      this.opts.onTrustStatus?.('unreachable', identity.publicKey)
      reportError('approvals', 'could not check operator trust before preparing a scope', e)
      return this.refusedPreparation('trust')
    }
    this.publishTrust(trust, identity)
    this.reportTrustRefusal(trust)
    if (trust !== 'compatible' || !this.isCurrentArm(generation)) return this.refusedPreparation('trust')

    const runRef = this.runRef()
    const inbox: Extract<ApprovalTokenInboxBlock, { kind: 'run' }> = {
      version: 1,
      kind: 'run',
      run_ref: runRef,
      group_id: target.groupId
    }
    const cred = generateCredential()
    const debt: RootDebt = { tokenId: deriveTokenId(cred.publicKey), deps }
    this.debt = debt
    let minted
    try {
      minted = await mintSessionToken(deps, {
        sessionPublicKey: cred.publicKey,
        sessionRef: `window-${this.opts.runId}`,
        inbox
      })
    } catch (e) {
      reportError('approvals', 'could not mint the prepared session credential', e)
      if (e instanceof BrokerHttpError && e.status >= 400 && e.status < 500 && this.debt === debt) {
        this.debt = null
      } else if (this.debt === debt) {
        reportError('approvals', "La réponse de création du credential n'est pas confirmée. Tout nouveau credential reste bloqué jusqu'à confirmation de la révocation.", e)
      }
      return this.refusedPreparation('mint-refused')
    }
    if (!this.isCurrentArm(generation)) {
      await this.revokeDebt(debt)
      return this.refusedPreparation('mint-refused')
    }
    if (minted.capabilities?.inbox_provenance !== 1) {
      reportError('approvals', 'broker does not attest Inbox provenance; prepared scope is unavailable')
      await this.revokeDebt(debt)
      return this.refusedPreparation('capability')
    }
    const expiresAt = this.renewalExpiry(minted.expires_at)
    if (!minted.token_id || !expiresAt) {
      reportError('approvals', 'broker did not return a valid session token identity and expiry; prepared scope is unavailable')
      await this.revokeDebt(debt)
      return this.refusedPreparation('mint-refused')
    }

    const publicPath = join(this.opts.stateDir, approvalCredFileName(target.projectKey, this.opts.runId, target.groupId))
    const privatePath = `${publicPath}.prepared-${generation}`
    try {
      writeFileAtomic(
        privatePath,
        JSON.stringify({
          brokerUrl: endpoint.url,
          brokerToken: endpoint.token,
          operatorId: identity.operatorId,
          tokenId: debt.tokenId,
          sessionRef: `window-${this.opts.runId}`,
          privateKey: cred.privateKey,
          publicKey: cred.publicKey,
          osUserHash: identity.osUserHash,
          origin: { host: this.opts.host, os_user_hash: identity.osUserHash, project_key: target.projectKey },
          inbox: { version: 1, run_ref: runRef, group_id: target.groupId }
        }),
        { mode: 0o600 }
      )
    } catch (e) {
      reportError('approvals', 'could not prepare the session credential file', e)
      await this.revokeDebt(debt)
      return this.refusedPreparation('local-file')
    }

    const supportsRenewal = minted.capabilities?.renew_only === true
    const prepared: PreparedRoot = {
      target,
      identity,
      debt,
      runRef,
      inbox,
      publicPath,
      privatePath,
      publicKey: cred.publicKey,
      expiresAt,
      renewal: supportsRenewal ? { publicKey: cred.publicKey, sessionRef: `window-${this.opts.runId}`, projectKey: target.projectKey, expiresAt, inbox } : null,
      supportsRenewal,
      installed: false,
      published: false,
      generation
    }
    this.preparation = prepared
    return this.readyPreparation(prepared)
  }

  private readyPreparation(prepared: PreparedRoot): ReadyRootPreparation {
    const canPublish = (): boolean => this.preparation === prepared && !this.closed && this.isCurrentArm(prepared.generation) && this.now() < Date.parse(prepared.expiresAt)
    return {
      state: 'ready',
      target: prepared.target,
      canPublish,
      install: () => {
        if (this.preparation !== prepared || this.closed || !this.isCurrentArm(prepared.generation)) {
          return this.refusedPreparation('mint-refused')
        }
        try {
          renameSync(prepared.privatePath, prepared.publicPath)
          prepared.installed = true
          return this.readyPreparation(prepared)
        } catch (e) {
          reportError('approvals', 'could not install the prepared session credential file', e)
          void this.abandonPreparation(prepared)
          return this.refusedPreparation('local-file')
        }
      },
      publish: () => {
        if (!prepared.installed || !canPublish()) {
          reportError('approvals', 'prepared root is no longer publishable')
          void this.abandonPreparation(prepared)
          throw new Error('prepared root is no longer publishable')
        }
        prepared.published = true
        this.preparation = null
        this.settlePreparationWaiters()
        this.identity = prepared.identity
        this.credPath = prepared.publicPath
        this.armed = true
        const root: RunRoot = { tokenId: prepared.debt.tokenId, deps: prepared.debt.deps, runRef: prepared.runRef, groupId: prepared.target.groupId, expiresAt: prepared.expiresAt }
        this.root = root
        for (const [callerRef, entry] of this.mandates) void this.mintMandate(callerRef, entry, root)
        if (prepared.renewal) {
          this.renewal = prepared.renewal
          this.scheduleRenewal(prepared.generation)
        } else if (prepared.supportsRenewal) {
          reportError('approvals', 'broker returned an invalid approval token expiry; renewal is disabled for this run')
        } else {
          reportError('approvals', 'broker does not support approval token renewal; renewal is disabled for this run')
        }
      },
      abandon: () => this.abandonPreparation(prepared)
    }
  }

  private refusedPreparation(cause: ScopeRefusalCause): RefusedRootPreparation {
    return { state: 'refused', cause, abandon: async () => {} }
  }

  private async abandonPreparation(prepared: PreparedRoot): Promise<void> {
    if (prepared.published) return
    if (this.preparation === prepared) this.preparation = null
    this.settlePreparationWaiters()
    try {
      rmSync(prepared.privatePath, { force: true })
      if (prepared.installed) rmSync(prepared.publicPath, { force: true })
    } catch (e) {
      reportError('approvals', 'could not remove an abandoned prepared credential file', e)
    }
    await this.revokeDebt(prepared.debt)
  }

  private unpublishRoot(): void {
    this.armed = false
    this.stopRenewal()
    this.dropRoot()
    const path = this.credPath
    this.credPath = null
    if (!path) return
    try {
      rmSync(path, { force: true })
    } catch (e) {
      reportError('approvals', 'could not remove the previous group credential file', e)
    }
  }

  async disarm(): Promise<void> {
    if (this.disarmInFlight) return this.disarmInFlight

    this.disarming = true
    this.settlePreparationWaiters(true)
    this.generation += 1
    this.armed = false
    this.stopRenewal()
    this.dropRoot()
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

  /**
   * Registers a deck-control caller's mandate. The authority comes from the
   * main's provisioning path, never from a label or a role. Minted at once when
   * a run credential is published, otherwise as soon as one is; until then the
   * mandate is pending and grants nothing.
   */
  requestMandate(callerRef: string, authority: InboxAuthority): void {
    const existing = this.mandates.get(callerRef)
    if (existing) {
      if (existing.authority !== authority) {
        reportError('approvals', `mandate for ${callerRef} already requested with another authority; kept as ${existing.authority}`)
      }
      return
    }
    const entry: MandateEntry = {
      authority,
      status: { state: 'pending' },
      attempt: 0,
      sessionRef: `window-${this.opts.runId}:${callerRef}`.slice(0, 128),
      root: null
    }
    this.mandates.set(callerRef, entry)
    if (this.armed && this.root) void this.mintMandate(callerRef, entry, this.root)
  }

  /** Local access first, then the broker: a mint landing later is revoked, never published. */
  releaseMandate(callerRef: string): void {
    const entry = this.mandates.get(callerRef)
    if (!entry) return
    this.mandates.delete(callerRef)
    entry.attempt += 1
    const status = entry.status
    entry.status = { state: 'refused' }
    if (status.state === 'ready' && entry.root) void this.revokeMandateToken(entry.root, status.tokenId, callerRef)
  }

  /** What a future Inbox action may use for this caller; an expired mandate is not ready. */
  mandateState(callerRef: string): MandateState | null {
    const entry = this.mandates.get(callerRef)
    if (!entry) return null
    const status = entry.status
    if (status.state === 'ready' && this.now() >= Date.parse(status.expiresAt)) return { state: 'refused' }
    return status
  }

  private dropRoot(): void {
    this.root = null
    // The broker revokes every mandate of a revoked root; locally they go back
    // to pending and are minted again under the next root.
    for (const entry of this.mandates.values()) {
      entry.attempt += 1
      entry.status = { state: 'pending' }
      entry.root = null
    }
  }

  private async mintMandate(callerRef: string, entry: MandateEntry, root: RunRoot): Promise<void> {
    const attempt = ++entry.attempt
    entry.status = { state: 'pending' }
    const cred = generateCredential()
    const tokenId = deriveTokenId(cred.publicKey)
    const current = (): boolean =>
      this.mandates.get(callerRef) === entry && entry.attempt === attempt && this.root === root
    try {
      const minted = await mintSessionToken(root.deps, {
        sessionPublicKey: cred.publicKey,
        sessionRef: entry.sessionRef,
        inbox: { version: 1, kind: 'mandate', parent_token_id: root.tokenId, caller_ref: callerRef, authority: entry.authority }
      })
      if (!current()) {
        await this.revokeMandateToken(root, tokenId, callerRef)
        return
      }
      const expiresAt = this.renewalExpiry(minted.expires_at)
      if (!expiresAt) {
        reportError('approvals', `broker returned an invalid mandate expiry for ${callerRef}; the mandate is refused`)
        entry.status = { state: 'refused' }
        await this.revokeMandateToken(root, tokenId, callerRef)
        return
      }
      entry.root = root
      entry.status = { state: 'ready', tokenId, publicKey: cred.publicKey, privateKey: cred.privateKey, expiresAt }
    } catch (e) {
      reportError('approvals', `could not mint the mandate of ${callerRef}`, e)
      if (current()) entry.status = { state: 'refused' }
    }
  }

  private startMandateRenewals(root: RunRoot): void {
    this.mandateRenewalAbort?.abort()
    const controller = new AbortController()
    this.mandateRenewalAbort = controller
    void this.renewMandates(root, controller.signal)
  }

  private async renewMandates(root: RunRoot, signal: AbortSignal): Promise<void> {
    await Promise.allSettled([...this.mandates].map(async ([callerRef, entry]) => {
      if (signal.aborted || this.root !== root) return
      const status = entry.status
      if (status.state === 'pending') return
      if (status.state === 'refused' || entry.root !== root || this.now() >= Date.parse(status.expiresAt)) {
        void this.mintMandate(callerRef, entry, root)
        return
      }
      const attempt = entry.attempt
      try {
        const response = await renewSessionToken(root.deps, {
          sessionPublicKey: status.publicKey,
          sessionRef: entry.sessionRef,
          inbox: { version: 1, kind: 'mandate', parent_token_id: root.tokenId, caller_ref: callerRef, authority: entry.authority },
          signal
        })
        if (this.mandates.get(callerRef) !== entry || entry.attempt !== attempt || this.root !== root) return
        const expiresAt = this.renewalExpiry(response.expires_at)
        if (!expiresAt) {
          reportError('approvals', `broker returned an invalid mandate expiry for ${callerRef}; it keeps its previous expiry`)
          return
        }
        entry.status = { ...status, expiresAt }
      } catch (e) {
        if (signal.aborted) return
        reportError('approvals', `could not renew the mandate of ${callerRef}; it keeps its previous expiry`, e)
      }
    }))
  }

  private async revokeMandateToken(root: RunRoot, tokenId: string, callerRef: string): Promise<void> {
    try {
      await revokeSessionToken(root.deps, tokenId)
    } catch (e) {
      reportError('approvals', `could not revoke the mandate of ${callerRef}; it ends with its run credential`, e)
    }
  }

  private safeGroupId(): string {
    try {
      return this.opts.groupId()
    } catch (e) {
      reportError('approvals', 'active group resolution failed', e)
      return ''
    }
  }

  private async finishDisarm(): Promise<void> {
    await this.armInFlight
    this.reportedRefusal = null
    const prepared = this.preparation
    if (prepared) await this.abandonPreparation(prepared)
    this.unpublishRoot()
    await this.revokeDebt()
    this.identity = null
  }
}

export function mandateBridge(runtime: Pick<ApprovalRuntime, 'requestMandate' | 'releaseMandate'>): {
  request: (callerRef: string, authority: InboxAuthority) => void
  release: (callerRef: string) => void
} {
  return {
    request: (callerRef, authority) => runtime.requestMandate(callerRef, authority),
    release: (callerRef) => runtime.releaseMandate(callerRef)
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

export async function retryOperatorTrust<T>(
  approvals: ApprovalRuntime,
  currentStatus: () => T
): Promise<T> {
  await approvals.retryTrust()
  return currentStatus()
}
