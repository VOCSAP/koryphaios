import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateCredential } from "../shared/approval.ts";
import { deckAuthored, FIXTURE_OPERATOR_ID, post, startBroker, stopBroker, type TestBroker } from "./_helper.ts";

type MintResult = { token_id?: string; error?: string };

type TokenRow = { revoked_at: string | null };

async function mint(broker: TestBroker, sessionPublicKey: string, sessionRef: string) {
  return post<MintResult>(
    `${broker.url}/approval/token-mint`,
    deckAuthored({
      session_public_key: sessionPublicKey,
      session_ref: sessionRef,
      project_key: "operator-trust-rotation",
    })
  );
}

function tokenRevokedAt(dbPath: string, tokenId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT revoked_at FROM approval_session_tokens WHERE token_id = ?").get(tokenId) as TokenRow | null;
    if (!row) throw new Error("minted session token row is missing");
    return row.revoked_at;
  } finally {
    db.close();
  }
}

async function stopAll(brokers: readonly TestBroker[]): Promise<void> {
  for (const broker of [...brokers].reverse()) await stopBroker(broker);
}

function requireTokenId(result: MintResult): string {
  if (!result.token_id) throw new Error("mint response has no token id");
  return result.token_id;
}

test("an absent or invalid policy revokes every active session token at startup", async () => {
  for (const trust of [null, ["not-an-ed25519-key"]] as const) {
    const source = await startBroker();
    let restarted: TestBroker | null = null;
    try {
      const session = generateCredential();
      const minted = await mint(source, session.publicKey, `policy-${trust === null ? "absent" : "invalid"}`);
      expect(minted.status).toBe(200);
      const tokenId = requireTokenId(minted.body);
      expect(tokenRevokedAt(source.dbPath, tokenId)).toBeNull();

      source.proc.kill();
      await source.proc.exited;
      restarted = await startBroker({ CLAUDE_PEERS_DB: source.dbPath }, { trustedOperators: trust });

      expect(tokenRevokedAt(source.dbPath, tokenId)).toBeString();
      const state = trust === null ? "unconfigured" : "invalid";
      const revocationLines = (await Bun.file(`${restarted.tmpDir}/logs/broker.log`).text())
        .split("\n")
        .filter((line) => line.includes("operator trust revoked active session tokens at startup"));
      expect(revocationLines).toHaveLength(1);
      const revocationLine = revocationLines[0];
      if (!revocationLine) throw new Error("revocation warning is missing");
      expect(revocationLine).toContain(`"count":1,"policy_state":"${state}"`);
      expect(revocationLine).not.toContain(FIXTURE_OPERATOR_ID);
    } finally {
      await stopAll([source, ...(restarted ? [restarted] : [])]);
    }
  }
}, 60_000);

test("a revoked session key stays refused after policy restoration while a fresh key mints", async () => {
  const source = await startBroker();
  let untrusted: TestBroker | null = null;
  let restored: TestBroker | null = null;
  try {
    const revokedSession = generateCredential();
    const firstMint = await mint(source, revokedSession.publicKey, "revoked-session");
    expect(firstMint.status).toBe(200);
    const revokedTokenId = requireTokenId(firstMint.body);

    source.proc.kill();
    await source.proc.exited;
    untrusted = await startBroker({ CLAUDE_PEERS_DB: source.dbPath }, { trustedOperators: [] });
    expect(tokenRevokedAt(source.dbPath, revokedTokenId)).toBeString();

    untrusted.proc.kill();
    await untrusted.proc.exited;
    restored = await startBroker({ CLAUDE_PEERS_DB: source.dbPath });
    const restoredLog = await Bun.file(`${restored.tmpDir}/logs/broker.log`).text();
    expect(restoredLog).not.toContain("operator trust revoked active session tokens at startup");

    const rejectedReuse = await mint(restored, revokedSession.publicKey, "revoked-session");
    const freshSession = generateCredential();
    const freshMint = await mint(restored, freshSession.publicKey, "fresh-session");

    expect([rejectedReuse.status, rejectedReuse.body.error]).toEqual([409, "session-token-revoked"]);
    expect(freshMint.status).toBe(200);
    const freshTokenId = requireTokenId(freshMint.body);
    expect(tokenRevokedAt(source.dbPath, freshTokenId)).toBeNull();
  } finally {
    await stopAll([source, ...(untrusted ? [untrusted] : []), ...(restored ? [restored] : [])]);
  }
}, 60_000);
