import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEnrolment,
  createOperatorIdentity,
  credentialWorks,
  exportEnrolment,
  loadOperatorIdentity,
} from "../desktop/src/main/operator-identity.ts";
import {
  projectApprovalSettings,
  remoteApprovalsEnabled,
  writeProjectApprovalSettings,
} from "../desktop/src/main/approval-store.ts";
import { buildKeystrokes, canApplyVerdict } from "../desktop/src/main/approval-service.ts";
import { generateCredential, deriveOperatorId } from "../shared/approval.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import type { Approval } from "../shared/types.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-appr-"));
  dirs.push(d);
  return d;
}

/** Reversible fake cipher (scope-secrets test pattern). */
const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (s: string) => Buffer.from(`X${s}`, "utf8"),
  decrypt: (b: Buffer) => b.toString("utf8").slice(1),
};

/** Stand-in for Linux without a keyring: encryption unavailable. */
const noCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => Buffer.from(""),
  decrypt: () => {
    throw new Error("unavailable");
  },
};

describe("operator identity", () => {
  test("first run mints a credential and persists it encrypted", () => {
    const dir = tmp();
    const id = loadOperatorIdentity(dir, fakeCipher);
    expect(id).not.toBeNull();
    expect(id?.operatorId).toMatch(/^[0-9a-f]{16}$/);

    const raw = readFileSync(join(dir, "operator.json"), "utf8");
    expect(raw).toContain("enc:");
    // The private half must never sit in the clear on disk.
    expect(raw).not.toContain(id!.privateKey);
  });

  test("the identity is stable across loads", () => {
    const dir = tmp();
    const first = loadOperatorIdentity(dir, fakeCipher);
    const second = loadOperatorIdentity(dir, fakeCipher);
    expect(second?.operatorId).toBe(first!.operatorId);
    expect(second?.privateKey).toBe(first!.privateKey);
  });

  test("two app-state dirs (two OS accounts) yield two identities", () => {
    // This is the compartmentalisation guarantee: %APPDATA% is per OS user, so
    // account A and account B on the SAME machine cannot collide.
    const a = loadOperatorIdentity(tmp(), fakeCipher);
    const b = loadOperatorIdentity(tmp(), fakeCipher);
    expect(a?.operatorId).not.toBe(b?.operatorId);
    expect(a?.osUserHash).not.toBe(b?.osUserHash);
  });

  test("operator_id is the digest of the public key (self-certifying)", () => {
    const id = loadOperatorIdentity(tmp(), fakeCipher);
    expect(id?.operatorId).toBe(deriveOperatorId(id!.publicKey));
  });

  test("without OS encryption it still works, explicitly in the clear", () => {
    const dir = tmp();
    const id = loadOperatorIdentity(dir, noCipher);
    expect(id).not.toBeNull();
    expect(readFileSync(join(dir, "operator.json"), "utf8")).toContain("plain:");
    expect(loadOperatorIdentity(dir, noCipher)?.operatorId).toBe(id!.operatorId);
  });

  test("an undecryptable identity returns null rather than silently minting a new one", () => {
    // Minting a fresh identity here would orphan the operator's phone pairing.
    const dir = tmp();
    createOperatorIdentity(dir, fakeCipher, generateCredential());
    const hostile: SecretCipher = {
      isAvailable: () => true,
      encrypt: () => Buffer.from(""),
      decrypt: () => {
        throw new Error("keychain changed");
      },
    };
    expect(loadOperatorIdentity(dir, hostile)).toBeNull();
  });

  test("a corrupt identity file is a null, not a crash", () => {
    const dir = tmp();
    writeFileSync(join(dir, "operator.json"), "{ not json");
    expect(loadOperatorIdentity(dir, fakeCipher)).toBeNull();
  });
});

describe("multi-PC enrolment", () => {
  test("PC#2 adopting the payload shares the identity", () => {
    const pc1 = tmp();
    const pc2 = tmp();
    const original = loadOperatorIdentity(pc1, fakeCipher);

    const payload = exportEnrolment(pc1, fakeCipher);
    expect(payload?.v).toBe(1);

    const adopted = applyEnrolment(pc2, fakeCipher, payload);
    expect(adopted?.operatorId).toBe(original!.operatorId);
    // Same identity, same salt -> the same origin label follows the person.
    expect(adopted?.osUserHash).toBe(original!.osUserHash);
    // ...and it survives a reload on PC#2.
    expect(loadOperatorIdentity(pc2, fakeCipher)?.operatorId).toBe(original!.operatorId);
  });

  test("garbage payloads are refused without throwing", () => {
    const dir = tmp();
    for (const bad of [null, undefined, 42, "string", {}, { privateKey: "x" }, { privateKey: "x", publicKey: "y" }]) {
      expect(applyEnrolment(dir, fakeCipher, bad)).toBeNull();
    }
  });

  test("a mismatched keypair is refused (probe before persist)", () => {
    const a = generateCredential();
    const b = generateCredential();
    expect(credentialWorks({ privateKey: a.privateKey, publicKey: b.publicKey })).toBe(false);
    expect(credentialWorks(a)).toBe(true);
    expect(
      applyEnrolment(tmp(), fakeCipher, { v: 1, privateKey: a.privateKey, publicKey: b.publicKey })
    ).toBeNull();
  });

  test("exporting from a machine with no identity yields null", () => {
    expect(exportEnrolment(tmp(), fakeCipher)).toBeNull();
  });
});

describe("per-project settings", () => {
  test("projects default to enabled (no opt-out)", () => {
    const file = join(tmp(), "approvals.json");
    expect(projectApprovalSettings(file, "proj").optOut).toBe(false);
  });

  test("an opt-out persists per project and does not leak to others", () => {
    const file = join(tmp(), "approvals.json");
    writeProjectApprovalSettings(file, "proj-a", { optOut: true });
    expect(projectApprovalSettings(file, "proj-a").optOut).toBe(true);
    expect(projectApprovalSettings(file, "proj-b").optOut).toBe(false);
  });

  test("global off beats everything — a project cannot opt IN", () => {
    const file = join(tmp(), "approvals.json");
    writeProjectApprovalSettings(file, "proj", { optOut: false });
    expect(remoteApprovalsEnabled({ globalEnabled: false, file, projectKey: "proj" })).toBe(false);
  });

  test("global on plus project opt-out is off", () => {
    const file = join(tmp(), "approvals.json");
    writeProjectApprovalSettings(file, "proj", { optOut: true });
    expect(remoteApprovalsEnabled({ globalEnabled: true, file, projectKey: "proj" })).toBe(false);
  });

  test("global on with no opt-out is on", () => {
    const file = join(tmp(), "approvals.json");
    expect(remoteApprovalsEnabled({ globalEnabled: true, file, projectKey: "proj" })).toBe(true);
  });

  test("a corrupt settings file falls back to defaults instead of disabling", () => {
    const file = join(tmp(), "approvals.json");
    writeFileSync(file, "{ broken");
    expect(remoteApprovalsEnabled({ globalEnabled: true, file, projectKey: "proj" })).toBe(true);
  });
});

describe("verdict -> keystrokes (the PTY fallback path)", () => {
  function approval(patch: Partial<Approval>): Approval {
    return {
      id: "a",
      operator_id: "op",
      origin: {
        host: "h",
        os_user_hash: "u",
        project_key: "p",
        group_id: "",
        from_peer: "",
        session_ref: "tile-1",
      },
      kind: "permission",
      title: "t",
      question: "q",
      options: [],
      status: "answered",
      answered_via: "telegram",
      answer_kind: null,
      answer_text: null,
      created_at: "",
      notif_expires_at: "",
      answered_at: "",
      delivered_at: null,
      ...patch,
    } as Approval;
  }

  test("allow accepts the highlighted option with a bare Enter", () => {
    expect(buildKeystrokes(approval({ answer_kind: "allow" }))).toBe("\r");
  });

  test("deny sends Escape rather than guessing a 'no' index", () => {
    // Guessing wrong could hit "yes, and don't ask again".
    expect(buildKeystrokes(approval({ answer_kind: "deny" }))).toBe("\x1b");
  });

  test("text is typed, then exactly one Enter added by us", () => {
    const out = buildKeystrokes(approval({ answer_kind: "text", answer_text: "use option 2" }));
    expect(out).toBe("use option 2\r");
    expect(out!.split("\r")).toHaveLength(2);
  });

  test("a remote answer can never carry its own submit", () => {
    const out = buildKeystrokes(
      approval({ answer_kind: "text", answer_text: "yes\rrm -rf /\nwhoami" })
    );
    // Exactly one CR — ours, at the very end.
    expect(out!.indexOf("\r")).toBe(out!.length - 1);
    expect(out).not.toContain("\n");
  });

  test("an empty or control-only text yields nothing to type", () => {
    expect(buildKeystrokes(approval({ answer_kind: "text", answer_text: "   " }))).toBeNull();
    expect(buildKeystrokes(approval({ answer_kind: "text", answer_text: null }))).toBeNull();
    expect(buildKeystrokes(approval({ answer_kind: null }))).toBeNull();
  });
});

describe("verdict application guards", () => {
  const answered = {
    status: "answered",
    answer_kind: "allow",
  } as unknown as Approval;

  test("applies only when the tile exists AND is still waiting", () => {
    expect(canApplyVerdict(answered, { exists: true, waiting: true })).toBe(true);
  });

  test("a session that stopped waiting is left alone", () => {
    // The operator already dealt with it locally; typing now would land on
    // whatever is on screen instead.
    expect(canApplyVerdict(answered, { exists: true, waiting: false })).toBe(false);
  });

  test("a closed or unknown session is left alone", () => {
    expect(canApplyVerdict(answered, { exists: false, waiting: true })).toBe(false);
    expect(canApplyVerdict(answered, null)).toBe(false);
  });

  test("an unsettled approval is never applied", () => {
    const pending = { status: "pending", answer_kind: null } as unknown as Approval;
    expect(canApplyVerdict(pending, { exists: true, waiting: true })).toBe(false);
  });
});
