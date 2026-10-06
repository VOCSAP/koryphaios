import { afterAll, expect, test } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import { buildAuthProof, deriveOperatorId, generateCredential, type ApprovalCredential } from "../shared/approval.ts";
import type { SessionApprovalCredential } from "../shared/approval-client.ts";
import { runApprovalClient } from "../desktop/hooks/approval-client.ts";

const brokers: TestBroker[] = [];
afterAll(async () => {
  for (const b of brokers) await stopBroker(b);
});

const PROJECT_KEY = "github.com/vocsap/koryphaios";

function operatorPost<T>(b: TestBroker, path: string, payload: Record<string, unknown>, op: { cred: ApprovalCredential; id: string }) {
  const body = { project_key: PROJECT_KEY, ...payload, public_key: op.cred.publicKey };
  const auth = buildAuthProof(op.cred.privateKey, body, { kind: "operator", operator_id: op.id });
  return post<T>(`${b.url}${path}`, { ...body, auth });
}

async function sessionCredential(b: TestBroker, op: { cred: ApprovalCredential; id: string }, sessionRef: string): Promise<SessionApprovalCredential> {
  const cred = generateCredential();
  const minted = await operatorPost<{ token_id: string }>(b, "/approval/token-mint", { session_public_key: cred.publicKey, session_ref: sessionRef }, op);
  expect(minted.status).toBe(200);
  return {
    brokerUrl: b.url,
    brokerToken: null,
    operatorId: op.id,
    tokenId: minted.body.token_id,
    sessionRef,
    privateKey: cred.privateKey,
    publicKey: cred.publicKey,
    osUserHash: "",
    blockSec: 900,
    origin: { host: "bureau", project_key: PROJECT_KEY },
  };
}

test("helper add then wait against a real broker: pending at timeout, then the operator's verdict", async () => {
  const b = await startBroker();
  brokers.push(b);
  const opCred = generateCredential();
  const op = { cred: opCred, id: deriveOperatorId(opCred.publicKey) };
  const cfg = await sessionCredential(b, op, "tile-1");

  const added = await runApprovalClient(
    "add",
    JSON.stringify({ kind: "permission", title: "Bash: rm x", question: "Allow?", options: ["Allow", "Deny"] }),
    cfg,
    "tile-1",
  );
  expect(added.ok).toBe(true);
  expect((added as Record<string, unknown>).reply_route, "the broker echoes the hook route").toBe("hook");
  const id = String((added as Record<string, unknown>).id ?? "");
  expect(id).toBeTruthy();
  const producer_secret = String((added as Record<string, unknown>).producer_secret ?? "");
  expect(producer_secret, "add hands the module the secret its wait and withdraw must present").toBeTruthy();

  const anonymous = await runApprovalClient("wait", JSON.stringify({ id, timeout_sec: 1 }), cfg, "tile-1");
  expect(anonymous, "without the secret the row reads as unknown").toEqual({ ok: false, error: "HTTP 404: unknown approval" });

  const idle = await runApprovalClient("wait", JSON.stringify({ id, timeout_sec: 1, producer_secret }), cfg, "tile-1");
  expect(idle).toEqual({ ok: true, pending: true });

  const claimed = await operatorPost(b, "/approval/claim", { id, via: "deck", answer_kind: "allow" }, op);
  expect(claimed.status).toBe(200);

  const settled = (await runApprovalClient("wait", JSON.stringify({ id, timeout_sec: 5, producer_secret }), cfg, "tile-1")) as {
    ok: boolean;
    approval?: { id: string; status: string; answer_kind: string };
  };
  expect(settled.ok).toBe(true);
  expect(settled.approval).toMatchObject({ id, status: "answered", answer_kind: "allow" });
});

test("helper withdraw against a real broker closes the module's own row without a verdict", async () => {
  const b = await startBroker();
  brokers.push(b);
  const opCred = generateCredential();
  const op = { cred: opCred, id: deriveOperatorId(opCred.publicKey) };
  const cfg = await sessionCredential(b, op, "tile-1");
  const added = await runApprovalClient("add", JSON.stringify({ kind: "permission", title: "t", question: "q" }), cfg, "tile-1");
  const id = String((added as Record<string, unknown>).id ?? "");
  const producer_secret = String((added as Record<string, unknown>).producer_secret ?? "");

  expect((await runApprovalClient("withdraw", JSON.stringify({ id }), cfg, "tile-1")).ok, "no secret, no withdraw").toBe(false);
  const withdrawn = await runApprovalClient("withdraw", JSON.stringify({ id, producer_secret }), cfg, "tile-1");
  expect(withdrawn).toEqual({
    ok: true,
    approval: { id, status: "answered_terminal", reply_route: "hook", answer_kind: null, answer_text: null, answered_via: null },
  });

  const after = await runApprovalClient("wait", JSON.stringify({ id, timeout_sec: 1, producer_secret }), cfg, "tile-1");
  expect(after).toMatchObject({ ok: true, approval: { status: "answered_terminal", answer_kind: null } });
  expect(JSON.stringify([withdrawn, after])).not.toContain(producer_secret);
});
