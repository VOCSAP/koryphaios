import { randomBytes } from "node:crypto";
import {
  CONTEXT_DEPOSIT_MAX_CHARS,
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

  unbind(instanceToken: string): void {
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
  perOwner: number;
  perGroup: number;
  total: number;
}

export interface ContextRegistryDeps {
  ownerIfActive: (instanceToken: string) => LiveOwner | null;
  now?: () => Date;
  newDepositId?: () => string;
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

interface Entry extends ContextDepositMeta {
  group_id: string;
  owner_instance_token: string;
  epoch: number;
  text: string;
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
  #limits: ContextRegistryLimits;

  constructor(deps: ContextRegistryDeps) {
    this.#ownerIfActive = deps.ownerIfActive;
    this.#now = deps.now ?? (() => new Date());
    this.#newDepositId = deps.newDepositId ?? (() => randomBytes(8).toString("hex"));
    this.#limits = {
      maxChars: deps.limits?.maxChars ?? CONTEXT_DEPOSIT_MAX_CHARS,
      perOwner: deps.limits?.perOwner ?? CONTEXT_DEPOSITS_PER_OWNER,
      perGroup: deps.limits?.perGroup ?? CONTEXT_DEPOSITS_PER_GROUP,
      total: deps.limits?.total ?? CONTEXT_DEPOSITS_TOTAL,
    };
  }

  get limits(): ContextRegistryLimits {
    return { ...this.#limits };
  }

  /** Called after every successful /register; a null hash (absent, malformed, exempt group) leaves the token unbound. */
  onRegister(instanceToken: string, capabilityHash: string | null): void {
    this.#dropOwner(instanceToken);
    if (capabilityHash === null) this.#bindings.unbind(instanceToken);
    else this.#bindings.bind(instanceToken, capabilityHash);
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
    const entry = this.#entries.get(depositId);
    return entry ? meta(entry) : null;
  }

  /** The live deposits of one owner, text included: reserved for the push path. */
  takeForPush(instanceToken: string): Array<ContextDepositMeta & { text: string }> {
    this.#sweepDead();
    return [...this.#entries.values()]
      .filter((e) => e.owner_instance_token === instanceToken)
      .map((e) => ({ ...meta(e), text: e.text }));
  }

  /** Frees the entries of owners that are gone or re-bound; returns how many were dropped. */
  sweep(): number {
    return this.#sweepDead();
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

  #dropOwner(instanceToken: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.owner_instance_token === instanceToken) this.#entries.delete(id);
    }
  }
}
