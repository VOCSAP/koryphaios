// Card 469f3176: ask_operator's blocking channel must exist WITHOUT a mobile
// transport. These tests target ApprovalRuntime.arm() directly (no electron
// import in approval-runtime.ts, so it is unit-testable under bun) and prove
// the specific regression the fix closes: arm() used to give up permanently
// when the persisted operator identity was unreadable, instead of minting a
// fresh one the way the roadmap signer already does unconditionally.
import { test, expect, describe, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, armApprovalsAtStartup } from "../desktop/src/main/approval-runtime.ts";
import { createOperatorIdentity, loadOperatorIdentity } from "../desktop/src/main/operator-identity.ts";
import { deriveOperatorId, generateCredential } from "../shared/approval.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-approval-runtime-"));
  dirs.push(d);
  return d;
}

/** Reversible fake cipher (same shape as tests/desktop-approvals.test.ts). */
const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (s: string) => Buffer.from(`X${s}`, "utf8"),
  decrypt: (b: Buffer) => b.toString("utf8").slice(1),
};

/** A cipher that can no longer decrypt what fakeCipher encrypted — simulates
 * a corrupted / re-keyed operator identity file. */
const hostileCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: () => Buffer.from(""),
  decrypt: () => {
    throw new Error("keychain changed");
  },
};

/** Models a keychain that is DOWN right now (locked, mid OS migration) -- the
 * exact same observable failure as real corruption from inside decrypt(),
 * which is precisely why isAvailable() (not the decrypt failure itself) has
 * to be the signal that tells the two apart. */
const unavailableCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => Buffer.from(""),
  decrypt: () => {
    throw new Error("keychain locked");
  },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** arm() mints a session token over the network; stub it out as a success. */
function stubMintSuccess(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token_id: "tok_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("armApprovalsAtStartup() -- the PRIMARY, behavioral proof for card 469f3176", () => {
  beforeEach(() => stubMintSuccess());

  // This is the real regression proof, not tests/desktop-approval-arm-unconditional.test.ts's
  // text scan (team-lead ruling, 2026-08-13): armApprovalsAtStartup()'s
  // signature takes no mobileApprovals-shaped argument at all. A `mobile:
  // false`-shaped config is built right here to make that concrete -- note it
  // is never passed to the function under test, because there is nowhere to
  // pass it. Reverting this extraction back to `if (config.mobileApprovals) {
  // await approvals.arm() }` inline in index.ts cannot be re-hidden from THIS
  // test the way it could hide from a text scan under a rephrased condition,
  // because arming a runtime and observing its result here does not go
  // through index.ts's call site at all -- it exercises the same arm() path
  // directly, with no config in scope to gate it.
  test("arms successfully with no mobile transport ever configured or reachable", async () => {
    const operatorNeverEnabledMobile = { mobileApprovals: false as const };
    void operatorNeverEnabledMobile; // documents the scenario; deliberately unused below

    const stateDir = tmp();
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      sessionRef: "window-test",
      host: "test-host",
    });

    const armed = await armApprovalsAtStartup(runtime);

    expect(armed).toBe(true);
    expect(runtime.deps()).not.toBeNull();
    expect(runtime.operator?.operatorId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("ApprovalRuntime.arm() without any mobile transport configured", () => {
  beforeEach(() => stubMintSuccess());

  test("succeeds on a machine that never enrolled (no identity file at all)", async () => {
    const stateDir = tmp();
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      sessionRef: "window-test",
      host: "test-host",
    });
    const armed = await runtime.arm();
    expect(armed).toBe(true);
    expect(runtime.deps()).not.toBeNull();
    expect(runtime.operator?.operatorId).toMatch(/^[0-9a-f]{16}$/);
  });

  // This is the regression this card fixes: before, a corrupted/undecryptable
  // identity file made arm() give up for good ("re-enrol this machine").
  // Reverting the `?? createOperatorIdentity(...)` fallback in arm() back to
  // a bare null-check-and-fail turns this test red. hostileCipher below has
  // isAvailable() === true (the keychain itself works, only THIS data is
  // bad), which is exactly the case arm()'s cipher.isAvailable() gate must
  // still let through -- see the "merely unavailable" describe block further
  // down for the case it must NOT let through.
  test("self-heals when the persisted identity is corrupt, instead of giving up", async () => {
    const stateDir = tmp();
    createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: hostileCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      sessionRef: "window-test",
      host: "test-host",
    });
    const armed = await runtime.arm();
    expect(armed).toBe(true);
    expect(runtime.deps()).not.toBeNull();
  });

  test("a fully corrupt identity FILE (not just an unreadable one) also self-heals", async () => {
    const stateDir = tmp();
    writeFileSync(join(stateDir, "operator.json"), "{ not json");
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      sessionRef: "window-test",
      host: "test-host",
    });
    const armed = await runtime.arm();
    expect(armed).toBe(true);
    expect(runtime.deps()).not.toBeNull();
  });
});

describe("ApprovalRuntime.arm() when the keychain is merely unavailable (not corrupt)", () => {
  beforeEach(() => stubMintSuccess());

  // Card 469f3176 REVIEW FINDING (mutation Q1): the first version of this fix
  // treated ANY decrypt failure as corruption and regenerated unconditionally
  // -- which destroyed a REAL identity the moment the keychain that
  // encrypted it became temporarily unavailable (locked, OS profile
  // mid-migration). Removing the `cipher.isAvailable()` gate in arm() (back
  // to unconditional `?? createOperatorIdentity(...)`) turns this test red:
  // the old identity gets replaced (new operator_id, and/or a .bak file
  // appears) instead of surviving completely untouched.
  test("gives up arming this run WITHOUT touching the existing identity", async () => {
    const stateDir = tmp();
    const original = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const file = join(stateDir, "operator.json");
    const before = readFileSync(file, "utf8");

    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: unavailableCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      sessionRef: "window-test",
      host: "test-host",
    });
    const armed = await runtime.arm();

    expect(armed).toBe(false);
    expect(runtime.deps()).toBeNull();

    // Byte-for-byte unchanged -- not merely "some identity exists", but THIS
    // exact identity, encrypted private key included.
    expect(readFileSync(file, "utf8")).toBe(before);

    // Nothing was even attempted to be backed up, because nothing was ever
    // written.
    const entries = readdirSync(stateDir);
    expect(entries.filter((f) => f.includes(".bak-"))).toHaveLength(0);
    expect(entries).toContain("operator.json");

    // Reloading with a WORKING cipher afterwards recovers the SAME identity
    // -- proof the outage, not the identity, was the problem.
    const recovered = loadOperatorIdentity(stateDir, fakeCipher);
    expect(recovered?.operatorId).toBe(original.operatorId);
    expect(recovered?.privateKey).toBe(original.privateKey);
  });
});

describe("createOperatorIdentity() backup-before-overwrite", () => {
  // A caller reaching createOperatorIdentity to replace an existing identity
  // (arm()'s self-heal, or applyEnrolment adopting a payload) must never
  // destroy the old private key -- see operator-identity.ts's doc comment.
  test("never destroys the previous identity: it survives as a .bak sibling", () => {
    const stateDir = tmp();
    const v1 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const v2 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());

    expect(v2.operatorId).not.toBe(v1.operatorId);

    const backups = readdirSync(stateDir).filter((f) => f.includes(".bak-"));
    expect(backups).toHaveLength(1);
    const backedUp = JSON.parse(readFileSync(join(stateDir, backups[0]!), "utf8"));
    expect(deriveOperatorId(backedUp.publicKey)).toBe(v1.operatorId);

    // The live file is v2, not v1.
    const live = loadOperatorIdentity(stateDir, fakeCipher);
    expect(live?.operatorId).toBe(v2.operatorId);
  });

  // D1 (team-lead, card 469f3176 review): a timestamp alone is not enough --
  // two backups computed in the SAME millisecond must not collide. Forcing
  // the actual millisecond to repeat (rather than hoping two fast calls land
  // in the same one) is the only way to prove the collision-handling branch
  // fires, not just that it happened not to be needed.
  test("two backups computed in the SAME millisecond do not clobber each other", () => {
    const stateDir = tmp();
    const v1 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const file = join(stateDir, "operator.json");

    const RealDate = globalThis.Date;
    const FIXED_ISO = "2026-01-01T00:00:00.000Z";
    class FrozenDate {
      toISOString(): string {
        return FIXED_ISO;
      }
    }
    // @ts-expect-error -- test-only global patch, restored in finally. Only
    // `new Date().toISOString()` (uniqueBackupPath's sole use of Date) is
    // exercised while this is installed.
    globalThis.Date = FrozenDate;
    try {
      const stamp = FIXED_ISO.replace(/[:.]/g, "-");
      // Pre-seed the EXACT path uniqueBackupPath will compute first, forcing
      // its existsSync/increment loop to actually run.
      writeFileSync(`${file}.bak-${stamp}`, "unrelated pre-existing file, must survive untouched");

      const v2 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());

      expect(readFileSync(`${file}.bak-${stamp}`, "utf8")).toBe(
        "unrelated pre-existing file, must survive untouched"
      );
      // v1 (the real prior identity, renamed by this call) landed at the
      // suffixed sibling instead of clobbering the pre-seeded file above.
      expect(existsSync(`${file}.bak-${stamp}-1`)).toBe(true);
      const v1Backup = JSON.parse(readFileSync(`${file}.bak-${stamp}-1`, "utf8"));
      expect(deriveOperatorId(v1Backup.publicKey)).toBe(v1.operatorId);
      expect(v2.operatorId).not.toBe(v1.operatorId);
    } finally {
      globalThis.Date = RealDate;
    }
  });
});
