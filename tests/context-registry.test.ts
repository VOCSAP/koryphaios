import { describe, expect, test } from "bun:test";
import {
  CONTEXT_DEPOSIT_MAX_CHARS,
  CONTEXT_DEPOSITS_PER_GROUP,
  CONTEXT_DEPOSITS_PER_OWNER,
  CONTEXT_DEPOSITS_TOTAL,
  DEPOSIT_CAPABILITY_ENV,
  hashCapability,
  isCapabilityShape,
  readGitFacts,
  validateDepositText,
  validateGitFacts,
} from "../shared/context-buffer.ts";
import { ContextRegistry, LaunchBindings, type LiveOwner } from "../shared/context-registry.ts";

const CAP_A = "a".repeat(64);
const CAP_B = "b".repeat(64);
const HASH_A = hashCapability(CAP_A);
const HASH_B = hashCapability(CAP_B);

interface Harness {
  registry: ContextRegistry;
  owners: Map<string, LiveOwner>;
}

function harness(limits: Partial<ConstructorParameters<typeof ContextRegistry>[0]["limits"]> = {}, ids?: () => string): Harness {
  const owners = new Map<string, LiveOwner>();
  let n = 0;
  const registry = new ContextRegistry({
    ownerIfActive: (token) => owners.get(token) ?? null,
    now: () => new Date(Date.UTC(2026, 9, 12, 12, 0, n++)),
    newDepositId: ids,
    limits,
  });
  return { registry, owners };
}

function deposit(registry: ContextRegistry, capabilityHash: string, text = "next: rerun the tests", replace?: string) {
  return registry.deposit({ capability_hash: capabilityHash, text, head: null, branch: null, git_root: null, replace });
}

function liveOwner(h: Harness, token: string, hash: string, peer_id = token, group_id = "g1"): void {
  h.owners.set(token, { peer_id, group_id });
  h.registry.onRegister(token, hash);
}

/** Every deposit currently visible, per owner, without the text. */
function snapshot(h: Harness, tokens: string[]): unknown {
  return tokens.map((t) => h.registry.takeForPush(t).map(({ text: _text, ...meta }) => meta));
}

describe("shared constants", () => {
  test("the capability env name survives CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which strips variables by name suffix", () => {
    const scrubbedSuffixes = ["_TOKEN", "_KEY", "_SECRET", "_CREDENTIAL", "_PASSWORD", "_PASSWD", "_AUTH", "_AUTH_MODE", "_APIKEY"];
    for (const suffix of scrubbedSuffixes) {
      expect(
        DEPOSIT_CAPABILITY_ENV.endsWith(suffix),
        `${DEPOSIT_CAPABILITY_ENV} ends with ${suffix}: Claude Code's env scrub would silently drop it from the agent's Bash, so the CLI could never deposit`
      ).toBe(false);
    }
    expect(DEPOSIT_CAPABILITY_ENV).toBe("CLAUDE_PEERS_DEPOSIT_CAPABILITY");
  });

  test("capability shape is 64 lowercase hex, and the hash differs from the raw value", () => {
    expect(isCapabilityShape(CAP_A)).toBe(true);
    expect(isCapabilityShape("A".repeat(64))).toBe(false);
    expect(isCapabilityShape("a".repeat(63))).toBe(false);
    expect(isCapabilityShape("")).toBe(false);
    expect(isCapabilityShape(undefined)).toBe(false);
    expect(HASH_A).toMatch(/^[0-9a-f]{64}$/);
    expect(HASH_A).not.toBe(CAP_A);
  });
});

describe("text validation", () => {
  test("the cap is counted in code points, astral characters included", () => {
    const astral = "\u{1F600}".repeat(CONTEXT_DEPOSIT_MAX_CHARS);
    expect(validateDepositText(astral, CONTEXT_DEPOSIT_MAX_CHARS)).toEqual({ ok: true, chars: CONTEXT_DEPOSIT_MAX_CHARS });
    expect(validateDepositText(astral + "x", CONTEXT_DEPOSIT_MAX_CHARS)).toEqual({
      ok: false,
      reason: "too_long",
      max_chars: CONTEXT_DEPOSIT_MAX_CHARS,
      got_chars: CONTEXT_DEPOSIT_MAX_CHARS + 1,
    });
  });

  test("each refused content class carries its own reason", () => {
    const cases: Array<[string, string]> = [
      ["", "empty_text"],
      [" \n\t ", "empty_text"],
      ["ok\uD800ok", "ill_formed_text"],
      ["ok\uDC00", "ill_formed_text"],
      ["ok\u0007ok", "forbidden_characters"],
      ["ok\u007Fok", "forbidden_characters"],
      ["ok\u0085ok", "forbidden_characters"],
      ["ok\u202Eok", "forbidden_characters"],
      ["ok\u2066ok", "forbidden_characters"],
      ["ok\u200Fok", "forbidden_characters"],
      ["ok\u2028ok", "forbidden_characters"],
      ["ok\u2029ok", "forbidden_characters"],
    ];
    for (const [text, reason] of cases) {
      const result = validateDepositText(text, CONTEXT_DEPOSIT_MAX_CHARS);
      expect({ text: JSON.stringify(text), reason: result.ok ? "accepted" : result.reason }).toEqual({ text: JSON.stringify(text), reason });
    }
    expect(validateDepositText("line\r\n\tindented", CONTEXT_DEPOSIT_MAX_CHARS)).toEqual({ ok: true, chars: 15 });
  });

  test("git facts: sha 40 or 64 hex or null, bounded names without control characters", () => {
    expect(validateGitFacts({ head: "0".repeat(40), branch: "main", git_root: "C:/repo" })).toBe(true);
    expect(validateGitFacts({ head: "f".repeat(64), branch: null, git_root: null })).toBe(true);
    expect(validateGitFacts({ head: null, branch: null, git_root: null })).toBe(true);
    expect(validateGitFacts({ head: "F".repeat(40), branch: null, git_root: null })).toBe(false);
    expect(validateGitFacts({ head: "0".repeat(41), branch: null, git_root: null })).toBe(false);
    expect(validateGitFacts({ head: null, branch: "a\nb", git_root: null })).toBe(false);
    expect(validateGitFacts({ head: null, branch: "", git_root: null })).toBe(false);
    expect(validateGitFacts({ head: null, branch: "x".repeat(1000), git_root: null })).toBe(false);
    expect(validateGitFacts({ head: null, branch: null, git_root: 42 })).toBe(false);
  });

  test("git facts are read with an argv array and no shell, and outside a repository all three are null", async () => {
    const calls: unknown[] = [];
    const facts = await readGitFacts("C:/somewhere", async (argv, options) => {
      calls.push({ argv, options });
      return { code: 128, stdout: "" };
    });
    expect(facts).toEqual({ head: null, branch: null, git_root: null });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls as Array<{ argv: unknown; options: Record<string, unknown> }>) {
      expect(Array.isArray(call.argv)).toBe(true);
      expect((call.argv as string[])[0]).toBe("git");
      expect(call.options.cwd).toBe("C:/somewhere");
      expect("shell" in call.options).toBe(false);
    }
  });
});

describe("ContextRegistry", () => {
  test("a nominal deposit is held under the owner's token and described without its text", () => {
    const h = harness();
    liveOwner(h, "tok-a", HASH_A, "peer-a");
    const r = deposit(h.registry, HASH_A, "witness-alpha");
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    expect(r.owner_peer_id).toBe("peer-a");
    expect(r.limit_chars).toBe(CONTEXT_DEPOSIT_MAX_CHARS);
    expect(r.deposit.state).toBe("held");
    expect(r.deposit.deposit_id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.held.map((d) => d.deposit_id)).toEqual([r.deposit.deposit_id]);
    expect(JSON.stringify(h.registry.describe(r.deposit.deposit_id))).not.toContain("witness-alpha");
    expect(h.registry.takeForPush("tok-a").map((d) => d.text)).toEqual(["witness-alpha"]);
  });

  test("the cap is the injected limit, not a value fixed in the code", () => {
    const limit = 7;
    const h = harness({ maxChars: limit });
    liveOwner(h, "tok-a", HASH_A);
    expect(deposit(h.registry, HASH_A, "x".repeat(limit)).ok).toBe(true);
    const over = deposit(h.registry, HASH_A, "x".repeat(limit + 1));
    expect(over).toMatchObject({ ok: false, status: 413, reason: "too_long", max_chars: limit, got_chars: limit + 1 });
    expect(h.registry.takeForPush("tok-a")).toHaveLength(1);
  });

  test("the default cap is CONTEXT_DEPOSIT_MAX_CHARS, refused one over with nothing stored", () => {
    const h = harness();
    liveOwner(h, "tok-a", HASH_A);
    expect(deposit(h.registry, HASH_A, "y".repeat(CONTEXT_DEPOSIT_MAX_CHARS)).ok).toBe(true);
    const r = deposit(h.registry, HASH_A, "y".repeat(CONTEXT_DEPOSIT_MAX_CHARS + 1));
    expect(r).toMatchObject({ ok: false, status: 413, reason: "too_long", max_chars: CONTEXT_DEPOSIT_MAX_CHARS });
    expect(h.registry.takeForPush("tok-a")).toHaveLength(1);
  });

  test("unknown capability, unbound token and inactive owner all answer the same 401", () => {
    const h = harness();
    expect(deposit(h.registry, HASH_A)).toEqual({ ok: false, status: 401, reason: "capability" });
    h.registry.onRegister("tok-a", HASH_A);
    expect(deposit(h.registry, HASH_A)).toEqual({ ok: false, status: 401, reason: "capability" });
    h.owners.set("tok-a", { peer_id: "a", group_id: "g1" });
    expect(deposit(h.registry, HASH_A).ok).toBe(true);
    h.registry.onRegister("tok-a", null);
    expect(deposit(h.registry, HASH_A)).toEqual({ ok: false, status: 401, reason: "capability" });
  });

  test("each quota refuses with its own reason and leaves the registry unchanged", () => {
    const owner = harness({ perOwner: 2, perGroup: 100, total: 100 });
    liveOwner(owner, "tok-a", HASH_A);
    deposit(owner.registry, HASH_A, "one");
    deposit(owner.registry, HASH_A, "two");
    const before = snapshot(owner, ["tok-a"]);
    const r = deposit(owner.registry, HASH_A, "three");
    expect(r).toMatchObject({ ok: false, status: 429, reason: "quota_owner" });
    if (!r.ok && r.reason === "quota_owner") expect(r.held_ids).toHaveLength(2);
    expect(snapshot(owner, ["tok-a"])).toEqual(before);

    const group = harness({ perOwner: 5, perGroup: 2, total: 100 });
    liveOwner(group, "tok-a", HASH_A, "a", "g1");
    liveOwner(group, "tok-b", HASH_B, "b", "g1");
    deposit(group.registry, HASH_A);
    deposit(group.registry, HASH_B);
    const gBefore = snapshot(group, ["tok-a", "tok-b"]);
    expect(deposit(group.registry, HASH_A)).toMatchObject({ ok: false, status: 429, reason: "quota_group" });
    expect(snapshot(group, ["tok-a", "tok-b"])).toEqual(gBefore);

    const total = harness({ perOwner: 5, perGroup: 5, total: 2 });
    liveOwner(total, "tok-a", HASH_A, "a", "g1");
    liveOwner(total, "tok-b", HASH_B, "b", "g2");
    deposit(total.registry, HASH_A);
    deposit(total.registry, HASH_B);
    const tBefore = snapshot(total, ["tok-a", "tok-b"]);
    expect(deposit(total.registry, HASH_A)).toMatchObject({ ok: false, status: 429, reason: "quota_total" });
    expect(snapshot(total, ["tok-a", "tok-b"])).toEqual(tBefore);
  });

  test("an explicit replace is atomic, evaluated after removal, and keeps the target on failure", () => {
    const h = harness({ perOwner: 1 });
    liveOwner(h, "tok-a", HASH_A);
    const first = deposit(h.registry, HASH_A, "first");
    if (!first.ok) throw new Error("first refused");
    const failed = deposit(h.registry, HASH_A, "z".repeat(CONTEXT_DEPOSIT_MAX_CHARS + 1), first.deposit.deposit_id);
    expect(failed).toMatchObject({ ok: false, reason: "too_long" });
    expect(h.registry.describe(first.deposit.deposit_id)).not.toBeNull();
    const second = deposit(h.registry, HASH_A, "second", first.deposit.deposit_id);
    if (!second.ok) throw new Error(`replace refused: ${second.reason}`);
    expect(second.replaced).toBe(first.deposit.deposit_id);
    expect(h.registry.describe(first.deposit.deposit_id)).toBeNull();
    expect(h.registry.takeForPush("tok-a").map((d) => d.text)).toEqual(["second"]);
  });

  test("replacing an unknown id and a foreign id give the identical 404", () => {
    const h = harness();
    liveOwner(h, "tok-a", HASH_A);
    liveOwner(h, "tok-b", HASH_B);
    const foreign = deposit(h.registry, HASH_B, "theirs");
    if (!foreign.ok) throw new Error("refused");
    const unknown = deposit(h.registry, HASH_A, "mine", "0123456789abcdef");
    const stolen = deposit(h.registry, HASH_A, "mine", foreign.deposit.deposit_id);
    expect(unknown).toEqual({ ok: false, status: 404, reason: "replace_not_found" });
    expect(stolen).toEqual(unknown);
    expect(h.registry.takeForPush("tok-b").map((d) => d.text)).toEqual(["theirs"]);
  });

  test("two active owners behind one hash are contested until one goes inactive", () => {
    const h = harness();
    liveOwner(h, "tok-tile", HASH_A);
    liveOwner(h, "tok-nested", HASH_A);
    expect(deposit(h.registry, HASH_A)).toEqual({ ok: false, status: 409, reason: "contested" });
    expect(h.registry.takeForPush("tok-tile")).toHaveLength(0);
    h.owners.delete("tok-nested");
    const r = deposit(h.registry, HASH_A);
    expect(r).toMatchObject({ ok: true, owner_peer_id: "tok-tile" });
  });

  test("a rename does not detach a deposit, and the entry stores no peer_id", () => {
    const h = harness();
    liveOwner(h, "tok-a", HASH_A, "before-rename");
    const r = deposit(h.registry, HASH_A, "kept");
    if (!r.ok) throw new Error("refused");
    h.owners.set("tok-a", { peer_id: "after-rename", group_id: "g1" });
    const [held] = h.registry.takeForPush("tok-a");
    expect(held?.text).toBe("kept");
    expect(Object.keys(held ?? {})).not.toContain("peer_id");
    expect(JSON.stringify(held)).not.toContain("before-rename");
  });

  test("every new register, same hash or another, drops the earlier deposits and moves the epoch", () => {
    const bindings = new LaunchBindings();
    const e1 = bindings.bind("tok-a", HASH_A);
    const e2 = bindings.bind("tok-a", HASH_A);
    expect(e2).not.toBe(e1);

    const h = harness();
    liveOwner(h, "tok-a", HASH_A);
    const first = deposit(h.registry, HASH_A, "old launch");
    if (!first.ok) throw new Error("refused");
    h.registry.onRegister("tok-a", HASH_A);
    expect(h.registry.describe(first.deposit.deposit_id)).toBeNull();
    const second = deposit(h.registry, HASH_A, "same launch reconnected");
    if (!second.ok) throw new Error("refused");
    h.registry.onRegister("tok-a", HASH_B);
    expect(h.registry.describe(second.deposit.deposit_id)).toBeNull();
    expect(deposit(h.registry, HASH_A)).toEqual({ ok: false, status: 401, reason: "capability" });
    expect(deposit(h.registry, HASH_B).ok).toBe(true);
  });

  test("deposit ids are unique: a colliding generator is asked again", () => {
    const queue = ["1111111111111111", "1111111111111111", "2222222222222222"];
    const h = harness({}, () => queue.shift() ?? "3333333333333333");
    liveOwner(h, "tok-a", HASH_A);
    const a = deposit(h.registry, HASH_A, "a");
    const b = deposit(h.registry, HASH_A, "b");
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.deposit.deposit_id).toBe("1111111111111111");
    expect(b.deposit.deposit_id).toBe("2222222222222222");
  });

  test("a sweep frees the entries of owners that are gone, and forgetOwner frees them at once", () => {
    const h = harness();
    liveOwner(h, "tok-a", HASH_A);
    liveOwner(h, "tok-b", HASH_B);
    const a = deposit(h.registry, HASH_A);
    const b = deposit(h.registry, HASH_B);
    if (!a.ok || !b.ok) throw new Error("refused");
    h.owners.delete("tok-a");
    expect(h.registry.sweep()).toBe(1);
    h.owners.set("tok-a", { peer_id: "a", group_id: "g1" });
    expect(h.registry.describe(a.deposit.deposit_id)).toBeNull();
    h.registry.forgetOwner("tok-b");
    expect(h.registry.describe(b.deposit.deposit_id)).toBeNull();
    expect(deposit(h.registry, HASH_B)).toEqual({ ok: false, status: 401, reason: "capability" });
  });

  test("every public method treats a deposit whose owner is gone as absent (enumerated by reflection)", () => {
    // A method added to the class without a probe here fails the test: the
    // classification is what proves the liveness filter covers it.
    const probes: Record<string, (h: Harness, depositId: string) => void> = {
      onRegister: (h, id) => {
        h.registry.onRegister("tok-other", HASH_B);
        expect(h.registry.describe(id)).toBeNull();
      },
      forgetOwner: (h, id) => {
        h.registry.forgetOwner("tok-other");
        expect(h.registry.describe(id)).toBeNull();
      },
      deposit: (h) => {
        expect(deposit(h.registry, HASH_A)).toEqual({ ok: false, status: 401, reason: "capability" });
      },
      describe: (h, id) => {
        expect(h.registry.describe(id)).toBeNull();
      },
      takeForPush: (h) => {
        expect(h.registry.takeForPush("tok-a")).toEqual([]);
      },
      sweep: (h, id) => {
        expect(h.registry.sweep()).toBe(1);
        expect(h.registry.describe(id)).toBeNull();
      },
      limits: (h) => {
        expect(h.registry.limits.maxChars).toBe(CONTEXT_DEPOSIT_MAX_CHARS);
      },
    };
    const methods = Object.getOwnPropertyNames(ContextRegistry.prototype).filter((n) => n !== "constructor");
    expect(methods.sort()).toEqual(Object.keys(probes).sort());
    for (const name of methods) {
      const h = harness({ perOwner: 1, perGroup: 1, total: 1 });
      liveOwner(h, "tok-a", HASH_A);
      const r = deposit(h.registry, HASH_A);
      if (!r.ok) throw new Error("refused");
      h.owners.delete("tok-a");
      probes[name]!(h, r.deposit.deposit_id);
    }
    // A dead owner's entry never counts against a quota.
    const q = harness({ perOwner: 1, perGroup: 1, total: 1 });
    liveOwner(q, "tok-a", HASH_A, "a", "g1");
    expect(deposit(q.registry, HASH_A).ok).toBe(true);
    q.owners.delete("tok-a");
    liveOwner(q, "tok-b", HASH_B, "b", "g1");
    expect(deposit(q.registry, HASH_B).ok).toBe(true);
  });

  test("the default quotas are the named constants", () => {
    const h = harness();
    expect(h.registry.limits).toEqual({
      maxChars: CONTEXT_DEPOSIT_MAX_CHARS,
      perOwner: CONTEXT_DEPOSITS_PER_OWNER,
      perGroup: CONTEXT_DEPOSITS_PER_GROUP,
      total: CONTEXT_DEPOSITS_TOTAL,
    });
  });

  test("the registry and buffer modules import nothing that reaches a database or the network", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    for (const file of ["context-registry.ts", "context-buffer.ts"]) {
      const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "shared", file), "utf8");
      const imports = transpiler.scanImports(src).map((i) => i.path).sort();
      for (const path of imports) {
        expect({ file, path, allowed: ["node:crypto", "./context-buffer.ts"].includes(path) }).toEqual({ file, path, allowed: true });
      }
    }
  });
});
