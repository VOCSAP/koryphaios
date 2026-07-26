import { test, expect, describe, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import { buildAuthProof, deriveOperatorId, generateCredential, type ApprovalCredential } from "../shared/approval.ts";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

function newOperator(): { cred: ApprovalCredential; id: string } {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
}
async function signedPost<T>(b: TestBroker, path: string, payload: Record<string, unknown>, op: { cred: ApprovalCredential; id: string }) {
  const body = { ...payload, public_key: op.cred.publicKey };
  const auth = buildAuthProof(op.cred.privateKey, body, { kind: "operator", operator_id: op.id });
  return post<T>(`${b.url}${path}`, { ...body, auth });
}

describe("channel routes", () => {
  test("listing with no channel configured reports all three as unconfigured", async () => {
    const b = await startBroker(); brokers.push(b);
    const op = newOperator();
    const res = await signedPost<{ channels: Array<Record<string, unknown>> }>(b, "/approval/channel-list", {}, op);
    expect(res.status).toBe(200);
    expect(res.body.channels.map((c) => c.kind)).toEqual(["telegram", "discord", "ntfy"]);
    expect(res.body.channels.every((c) => c.configured === false)).toBe(true);
  }, 30_000);

  test("a token the provider refuses leaves nothing configured behind", async () => {
    // No network in tests: getMe fails, so connect must roll back.
    const b = await startBroker(); brokers.push(b);
    const op = newOperator();
    const conn = await signedPost<{ error: string }>(b, "/approval/channel-connect", { kind: "telegram", token: "bogus" }, op);
    expect(conn.status).toBe(400);
    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(b, "/approval/channel-list", {}, op);
    expect(list.body.channels.find((c) => c.kind === "telegram")!.configured).toBe(false);
  }, 60_000);

  test("connect requires a kind and a token", async () => {
    const b = await startBroker(); brokers.push(b);
    const op = newOperator();
    expect((await signedPost(b, "/approval/channel-connect", { kind: "telegram" }, op)).status).toBe(400);
    expect((await signedPost(b, "/approval/channel-connect", { kind: "smoke", token: "x" }, op)).status).toBe(400);
  }, 30_000);

  test("channel routes reject a session credential", async () => {
    const b = await startBroker(); brokers.push(b);
    const op = newOperator();
    const sess = generateCredential();
    const mintBody = { session_public_key: sess.publicKey, session_ref: "w", public_key: op.cred.publicKey };
    const auth = buildAuthProof(op.cred.privateKey, mintBody, { kind: "operator", operator_id: op.id });
    const minted = await post<{ token_id: string }>(`${b.url}/approval/token-mint`, { ...mintBody, auth });
    const body = { public_key: sess.publicKey };
    const sauth = buildAuthProof(sess.privateKey, body, { kind: "session", operator_id: op.id, token_id: minted.body.token_id });
    const res = await post<{ error: string }>(`${b.url}/approval/channel-list`, { ...body, auth: sauth });
    expect(res.status).toBe(403);
  }, 30_000);

  test("disconnect is idempotent", async () => {
    const b = await startBroker(); brokers.push(b);
    const op = newOperator();
    const res = await signedPost<{ removed: number }>(b, "/approval/channel-disconnect", { kind: "telegram" }, op);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);
  }, 30_000);
});
