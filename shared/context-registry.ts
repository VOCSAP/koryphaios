import { randomBytes } from "node:crypto";
import {
  CONTEXT_DEPOSIT_MAX_CHARS,
  CONTEXT_RESERVATION_TTL_MS,
  CONTEXT_RESUME_ACK_TTL_MS,
  CONTEXT_DEPOSITS_PER_GROUP,
  CONTEXT_DEPOSITS_PER_OWNER,
  CONTEXT_DEPOSITS_TOTAL,
  validateDepositText,
  type ContextDepositMeta,
} from "./context-buffer.ts";

/**
 * Which launch holds which capability hash, in RAM only. Every bind mints a
 * new broker-wide epoch, so a deposit made under an earlier bind of the same
 * token can never match again.
 */
export class LaunchBindings {
  #byToken = new Map<string, { capability_hash: string; epoch: number }>();
  #byHash = new Map<string, Set<string>>();
  #resumeVersions = new Map<string, number>();
  #lastEpoch = 0;

  bind(instanceToken: string, capabilityHash: string): number {
    this.unbind(instanceToken);
    const epoch = ++this.#lastEpoch;
    this.#byToken.set(instanceToken, { capability_hash: capabilityHash, epoch });
    const tokens = this.#byHash.get(capabilityHash) ?? new Set<string>();
    tokens.add(instanceToken);
    this.#byHash.set(capabilityHash, tokens);
    return epoch;
  }

  setResumeVersion(instanceToken: string, version: number): void {
    if (this.#byToken.has(instanceToken)) this.#resumeVersions.set(instanceToken, version);
  }

  resumeVersionOf(instanceToken: string): number | undefined {
    return this.#resumeVersions.get(instanceToken);
  }

  unbind(instanceToken: string): void {
    this.#resumeVersions.delete(instanceToken);
    const previous = this.#byToken.get(instanceToken);
    if (!previous) return;
    this.#byToken.delete(instanceToken);
    const tokens = this.#byHash.get(previous.capability_hash);
    tokens?.delete(instanceToken);
    if (tokens && tokens.size === 0) this.#byHash.delete(previous.capability_hash);
  }

  epochOf(instanceToken: string): number | undefined {
    return this.#byToken.get(instanceToken)?.epoch;
  }

  tokensFor(capabilityHash: string): string[] {
    return [...(this.#byHash.get(capabilityHash) ?? [])];
  }
}

/** A peer row that is active and local (neither relayed nor mirrored); null otherwise. */
export interface LiveOwner {
  peer_id: string;
  group_id: string;
}

export interface ContextRegistryLimits {
  maxChars: number;
  reservationTtlMs: number;
  perOwner: number;
  perGroup: number;
  total: number;
}

export interface ContextRegistryDeps {
  ownerIfActive: (instanceToken: string) => LiveOwner | null;
  now?: () => Date;
  newDepositId?: () => string;
  newAttemptId?: () => string;
  limits?: Partial<ContextRegistryLimits>;
}

export interface DepositInput {
  capability_hash: string;
  text: string;
  head: string | null;
  branch: string | null;
  git_root: string | null;
  replace?: string | null;
}

export type DepositOutcome =
  | {
      ok: true;
      deposit: ContextDepositMeta;
      owner_peer_id: string;
      limit_chars: number;
      replaced: string | null;
      held: ContextDepositMeta[];
    }
  | { ok: false; status: 401; reason: "capability" }
  | { ok: false; status: 409; reason: "contested" }
  | { ok: false; status: 404; reason: "replace_not_found" }
  | { ok: false; status: 413; reason: "too_long"; max_chars: number; got_chars: number }
  | { ok: false; status: 400; reason: "empty_text" | "ill_formed_text" | "forbidden_characters" }
  | { ok: false; status: 429; reason: "quota_owner"; held_ids: string[] }
  | { ok: false; status: 429; reason: "quota_group" | "quota_total" };

export type ReservationOutcome =
  | { ok: true; deposit: ContextDepositMeta; attempt_id: string }
  | { ok: false; reason: "unavailable" | "owner_lacks_context_resume" };

export type ReleaseOutcome =
  | { ok: true; deposit: ContextDepositMeta; attempt_id: string; released: boolean; resume_delivery: "pending" | "sent" | null }
  | { ok: false; reason: "unavailable" | "contradictory" };

export type ContextResumeDeposit = ContextDepositMeta & {
  text: string;
  owner_instance_token: string;
  released_attempt_id: string;
};

interface Entry extends ContextDepositMeta {
  group_id: string;
  owner_instance_token: string;
  epoch: number;
  text: string;
  attempt_id: string | null;
  released_attempt_id: string | null;
  reserved_at_ms: number | null;
  ack_deadline_ms: number | null;
  resume_delivery: "pending" | "sent" | null;
}

function meta(entry: Entry): ContextDepositMeta {
  return {
    deposit_id: entry.deposit_id,
    chars: entry.chars,
    deposited_at: entry.deposited_at,
    head_at_deposit: entry.head_at_deposit,
    branch: entry.branch,
    git_root: entry.git_root,
    state: entry.state,
  };
}

/**
 * Ephemeral context deposits, keyed by deposit_id and owned by
 * (instance_token, epoch), never by peer_id. Every public method first drops
 * the entries whose owner is not an active local peer or whose launch was
 * re-bound since the deposit: liveness is derived on each call, so nothing
 * has to revoke it.
 */
export class ContextRegistry {
  #entries = new Map<string, Entry>();
  #bindings = new LaunchBindings();
  #ownerIfActive: (instanceToken: string) => LiveOwner | null;
  #now: () => Date;
  #newDepositId: () => string;
  #newAttemptId: () => string;
  #limits: ContextRegistryLimits;

  constructor(deps: ContextRegistryDeps) {
    this.#ownerIfActive = deps.ownerIfActive;
    this.#now = deps.now ?? (() => new Date());
    this.#newDepositId = deps.newDepositId ?? (() => randomBytes(8).toString("hex"));
    this.#newAttemptId = deps.newAttemptId ?? (() => randomBytes(16).toString("hex"));
    this.#limits = {
      maxChars: deps.limits?.maxChars ?? CONTEXT_DEPOSIT_MAX_CHARS,
      reservationTtlMs: deps.limits?.reservationTtlMs ?? CONTEXT_RESERVATION_TTL_MS,
      perOwner: deps.limits?.perOwner ?? CONTEXT_DEPOSITS_PER_OWNER,
      perGroup: deps.limits?.perGroup ?? CONTEXT_DEPOSITS_PER_GROUP,
      total: deps.limits?.total ?? CONTEXT_DEPOSITS_TOTAL,
    };
  }

  get limits(): ContextRegistryLimits {
    return { ...this.#limits };
  }

  /**
   * Called after every successful /register; a null hash (absent, malformed,
   * exempt group) leaves the token unbound. The resume version counts only
   * when it is a positive safe integer on a bound token.
   */
  onRegister(instanceToken: string, capabilityHash: string | null, resumeVersion: number | null = null): void {
    this.#dropOwner(instanceToken);
    if (capabilityHash === null) this.#bindings.unbind(instanceToken);
    else this.#bindings.bind(instanceToken, capabilityHash);
    if (resumeVersion !== null && Number.isSafeInteger(resumeVersion) && resumeVersion >= 1) {
      this.#bindings.setResumeVersion(instanceToken, resumeVersion);
    }
    this.#sweepDead();
  }

  /** Disconnect or unregister: the RAM is freed now rather than at the next sweep. */
  forgetOwner(instanceToken: string): void {
    this.#dropOwner(instanceToken);
    this.#bindings.unbind(instanceToken);
    this.#sweepDead();
  }

  deposit(input: DepositInput): DepositOutcome {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const candidates = this.#bindings
      .tokensFor(input.capability_hash)
      .map((token) => ({ token, owner: this.#ownerIfActive(token) }))
      .filter((c): c is { token: string; owner: LiveOwner } => c.owner !== null);
    if (candidates.length === 0) return { ok: false, status: 401, reason: "capability" };
    if (candidates.length > 1) return { ok: false, status: 409, reason: "contested" };
    const { token, owner } = candidates[0]!;
    const epoch = this.#bindings.epochOf(token);
    if (epoch === undefined) return { ok: false, status: 401, reason: "capability" };

    const verdict = validateDepositText(input.text, this.#limits.maxChars);
    if (!verdict.ok) {
      if (verdict.reason === "too_long") {
        return { ok: false, status: 413, reason: "too_long", max_chars: verdict.max_chars, got_chars: verdict.got_chars };
      }
      return { ok: false, status: 400, reason: verdict.reason };
    }

    let replaced: Entry | null = null;
    if (input.replace) {
      const target = this.#entries.get(input.replace);
      if (!target || target.owner_instance_token !== token || target.state !== "held") {
        return { ok: false, status: 404, reason: "replace_not_found" };
      }
      replaced = target;
    }

    const live = [...this.#entries.values()].filter((e) => e !== replaced);
    const mine = live.filter((e) => e.owner_instance_token === token);
    if (mine.length >= this.#limits.perOwner) {
      return { ok: false, status: 429, reason: "quota_owner", held_ids: mine.map((e) => e.deposit_id) };
    }
    if (live.filter((e) => e.group_id === owner.group_id).length >= this.#limits.perGroup) {
      return { ok: false, status: 429, reason: "quota_group" };
    }
    if (live.length >= this.#limits.total) return { ok: false, status: 429, reason: "quota_total" };

    let depositId = this.#newDepositId();
    while (this.#entries.has(depositId)) depositId = this.#newDepositId();
    const entry: Entry = {
      deposit_id: depositId,
      group_id: owner.group_id,
      owner_instance_token: token,
      epoch,
      text: input.text,
      chars: verdict.chars,
      head_at_deposit: input.head,
      branch: input.branch,
      git_root: input.git_root,
      deposited_at: this.#now().toISOString(),
      state: "held",
      attempt_id: null,
      released_attempt_id: null,
      reserved_at_ms: null,
      ack_deadline_ms: null,
      resume_delivery: null,
    };
    if (replaced) this.#entries.delete(replaced.deposit_id);
    this.#entries.set(depositId, entry);
    return {
      ok: true,
      deposit: meta(entry),
      owner_peer_id: owner.peer_id,
      limit_chars: this.#limits.maxChars,
      replaced: replaced?.deposit_id ?? null,
      held: [...this.#entries.values()].filter((e) => e.owner_instance_token === token).map(meta),
    };
  }

  /** Metadata of a live deposit, never its text. */
  describe(depositId: string): ContextDepositMeta | null {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const entry = this.#entries.get(depositId);
    return entry ? meta(entry) : null;
  }

  reserve(depositId: string, target: LiveOwner): ReservationOutcome {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const entry = this.#entries.get(depositId);
    if (!entry || entry.state !== "held") return { ok: false, reason: "unavailable" };
    const owner = this.#ownerIfActive(entry.owner_instance_token);
    if (!owner || owner.peer_id !== target.peer_id || owner.group_id !== target.group_id) {
      return { ok: false, reason: "unavailable" };
    }
    if (this.#bindings.resumeVersionOf(entry.owner_instance_token) === undefined) {
      return { ok: false, reason: "owner_lacks_context_resume" };
    }
    const attempt_id = this.#newAttemptId();
    entry.state = "reserved";
    entry.attempt_id = attempt_id;
    entry.released_attempt_id = null;
    entry.reserved_at_ms = this.#now().getTime();
    return { ok: true, deposit: meta(entry), attempt_id };
  }

  release(depositId: string, groupId: string, attemptId: string, cleared = false): ReleaseOutcome {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const entry = this.#entries.get(depositId);
    if (!entry || entry.group_id !== groupId) return { ok: false, reason: "unavailable" };
    if (entry.state === "reserved" && entry.attempt_id === attemptId) {
      entry.state = cleared ? "resuming" : "held";
      entry.attempt_id = null;
      entry.released_attempt_id = attemptId;
      entry.reserved_at_ms = null;
      entry.ack_deadline_ms = null;
      entry.resume_delivery = cleared ? "pending" : null;
      return { ok: true, deposit: meta(entry), attempt_id: attemptId, released: true, resume_delivery: entry.resume_delivery };
    }
    if (entry.released_attempt_id === attemptId && (entry.state === "held" || entry.state === "resuming")) {
      if ((entry.state === "resuming") !== cleared) return { ok: false, reason: "contradictory" };
      return { ok: true, deposit: meta(entry), attempt_id: attemptId, released: false, resume_delivery: entry.resume_delivery };
    }
    return { ok: false, reason: "unavailable" };
  }

  takeReleasedForResume(depositId: string, attemptId: string): ContextResumeDeposit | null {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const entry = this.#entries.get(depositId);
    if (
      !entry ||
      entry.state !== "resuming" ||
      entry.released_attempt_id !== attemptId ||
      entry.ack_deadline_ms !== null
    ) return null;
    return { ...meta(entry), text: entry.text, owner_instance_token: entry.owner_instance_token, released_attempt_id: attemptId };
  }

  markResumeSent(depositId: string, attemptId: string): void {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const entry = this.#entries.get(depositId);
    if (entry && entry.state === "resuming" && entry.released_attempt_id === attemptId && entry.ack_deadline_ms === null) {
      entry.resume_delivery = "sent";
    }
  }

  resumeDelivery(depositId: string, attemptId: string): "pending" | "sent" | null {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const entry = this.#entries.get(depositId);
    return entry?.state === "resuming" && entry.released_attempt_id === attemptId ? entry.resume_delivery : null;
  }

  pendingResumesForOwner(instanceToken: string): Array<{ deposit_id: string; attempt_id: string }> {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    return [...this.#entries.values()]
      .filter((entry) => entry.owner_instance_token === instanceToken && entry.state === "resuming" && entry.released_attempt_id !== null && entry.ack_deadline_ms === null)
      .map((entry) => ({ deposit_id: entry.deposit_id, attempt_id: entry.released_attempt_id! }));
  }

  acknowledgeResume(depositId: string, attemptId: string, instanceToken: string): { ok: true } | { ok: false; reason: "unavailable" } {
    this.#sweepDead();
    this.#releaseExpiredReservations();
    this.#purgeExpiredAcknowledgedResumes();
    const entry = this.#entries.get(depositId);
    if (
      !entry ||
      entry.state !== "resuming" ||
      entry.released_attempt_id !== attemptId ||
      entry.owner_instance_token !== instanceToken
    ) return { ok: false, reason: "unavailable" };
    this.#armTechnicalAckDeadline(entry);
    return { ok: true };
  }


  /** Frees the entries of owners that are gone or re-bound; returns how many were dropped. */
  sweep(): number {
    const dropped = this.#sweepDead();
    this.#releaseExpiredReservations();
    return dropped + this.#purgeExpiredAcknowledgedResumes();
  }

  #isLive(entry: Entry): boolean {
    return (
      this.#ownerIfActive(entry.owner_instance_token) !== null &&
      this.#bindings.epochOf(entry.owner_instance_token) === entry.epoch
    );
  }

  #sweepDead(): number {
    let dropped = 0;
    for (const [id, entry] of this.#entries) {
      if (!this.#isLive(entry)) {
        this.#entries.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  #releaseExpiredReservations(): void {
    const now = this.#now().getTime();
    for (const entry of this.#entries.values()) {
      const reservedAt = entry.reserved_at_ms;
      if (entry.state !== "reserved" || reservedAt === null || now - reservedAt < this.#limits.reservationTtlMs) continue;
      entry.state = "held";
      entry.attempt_id = null;
      entry.released_attempt_id = null;
      entry.reserved_at_ms = null;
    }
  }

  #armTechnicalAckDeadline(entry: Entry): void {
    if (entry.ack_deadline_ms === null) entry.ack_deadline_ms = this.#now().getTime() + CONTEXT_RESUME_ACK_TTL_MS;
  }

  #purgeExpiredAcknowledgedResumes(): number {
    const now = this.#now().getTime();
    let dropped = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.ack_deadline_ms !== null && now >= entry.ack_deadline_ms) {
        this.#entries.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  #dropOwner(instanceToken: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.owner_instance_token === instanceToken) this.#entries.delete(id);
    }
  }
}
