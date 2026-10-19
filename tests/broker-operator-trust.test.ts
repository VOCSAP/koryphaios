import { afterAll, describe, expect, test } from "bun:test";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";
import {
  FIXTURE_OPERATOR_ID,
  deckAuthored,
  get,
  post,
  startBroker,
  stopBroker,
  type StartBrokerOptions,
  type TestBroker,
  openBrokerDb,
} from "./_helper.ts";

const brokers: TestBroker[] = [];

afterAll(async () => {
  for (const broker of brokers) await stopBroker(broker);
});

async function boot(options: StartBrokerOptions = {}): Promise<TestBroker> {
  const broker = await startBroker({}, options);
  brokers.push(broker);
  return broker;
}

function signedCheck(): Record<string, unknown> {
  const credential = generateCredential();
  const operatorId = deriveOperatorId(credential.publicKey);
  const body = { public_key: credential.publicKey };
  return {
    ...body,
    auth: buildAuthProof(credential.privateKey, body, { kind: "operator", operator_id: operatorId }),
  };
}

type Health = {
  status: string;
  operator_trust_version?: number;
  operator_trust_state?: string;
};

describe("operator trust at broker startup", () => {
  test("the default test policy trusts only the fixture operator", async () => {
    const broker = await boot();

    const trusted = await post<{ operator_id: string; protocol_version: number }>(
      `${broker.url}/operator/check`,
      deckAuthored({})
    );
    expect(trusted.status).toBe(200);
    expect(trusted.body).toEqual({ operator_id: FIXTURE_OPERATOR_ID, protocol_version: 1 });

    const untrusted = await post<{ error: string }>(`${broker.url}/operator/check`, signedCheck());
    expect(untrusted.status).toBe(403);
    expect(untrusted.body.error).toBe("operator-not-trusted");
  });

  test("an approval_operators record does not grant operator trust", async () => {
    const broker = await boot();
    const credential = generateCredential();
    const operatorId = deriveOperatorId(credential.publicKey);
    const db = openBrokerDb(broker.dbPath);
    db.run(
      `INSERT INTO approval_operators (operator_id, public_key, label, created_at, last_seen_at)
       VALUES (?, ?, '', datetime('now'), datetime('now'))`,
      [operatorId, credential.publicKey]
    );
    db.close();

    const body = { public_key: credential.publicKey };
    const refusal = await post<{ error: string }>(`${broker.url}/operator/check`, {
      ...body,
      auth: buildAuthProof(credential.privateKey, body, { kind: "operator", operator_id: operatorId }),
    });
    expect(refusal.status).toBe(403);
    expect(refusal.body.error).toBe("operator-not-trusted");
  });

  test("operator-check rejects a session proof", async () => {
    const broker = await boot();
    const session = generateCredential();
    const minted = await post<{ token_id: string }>(
      `${broker.url}/approval/token-mint`,
      deckAuthored({
        session_public_key: session.publicKey,
        session_ref: "operator-check-session",
        project_key: "operator-check-project",
      })
    );
    expect(minted.status).toBe(200);

    const sessionBody = { public_key: session.publicKey };
    const sessionRefusal = await post<{ error: string }>(`${broker.url}/operator/check`, {
      ...sessionBody,
      auth: buildAuthProof(session.privateKey, sessionBody, {
        kind: "session",
        operator_id: FIXTURE_OPERATOR_ID,
        token_id: minted.body.token_id,
      }),
    });
    expect(sessionRefusal.status).toBe(403);
    expect(sessionRefusal.body.error).toBe("credential may not operator-check");
  });

  test("operator-check rejects an invalid proof from a trusted operator", async () => {
    const broker = await boot();
    const malformed = deckAuthored({}) as { auth: { sig: string } } & Record<string, unknown>;
    malformed.auth.sig = "invalid";

    const invalidSignature = await post<{ error: string }>(`${broker.url}/operator/check`, malformed);
    expect(invalidSignature.status).toBe(401);
  });

  test("health exposes a non-sensitive trust state while liveness stays ready", async () => {
    const broker = await boot({ trustedOperators: [] });
    const health = await get<Health>(`${broker.url}/health`);

    expect(health.status).toBe(200);
    expect(health.body.operator_trust_version).toBe(1);
    expect(health.body.operator_trust_state).toBe("ready");

    const refused = await post<{ error: string }>(`${broker.url}/operator/check`, deckAuthored({}));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("operator-not-trusted");
  });

  test("unconfigured and invalid policies refuse privileged proofs with 503", async () => {
    const absent = await boot({ trustedOperators: null });
    const absentHealth = await get<Health>(`${absent.url}/health`);
    expect(absentHealth.status).toBe(200);
    expect(absentHealth.body.operator_trust_state).toBe("unconfigured");
    const absentRefusal = await post<{ error: string }>(`${absent.url}/operator/check`, deckAuthored({}));
    expect(absentRefusal.status).toBe(503);
    expect(absentRefusal.body.error).toBe("operator-trust-unconfigured");

    const invalid = await boot({ trustedOperators: ["not-an-ed25519-key"] });
    const invalidHealth = await get<Health>(`${invalid.url}/health`);
    expect(invalidHealth.status).toBe(200);
    expect(invalidHealth.body.operator_trust_state).toBe("invalid");
    const invalidRefusal = await post<{ error: string }>(`${invalid.url}/operator/check`, deckAuthored({}));
    expect(invalidRefusal.status).toBe(503);
    expect(invalidRefusal.body.error).toBe("operator-trust-invalid");
  });
});
