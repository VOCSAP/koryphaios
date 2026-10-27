import { expect, test } from "bun:test";
import { inboxDepositReadiness, type InboxDepositCredential, type InboxDepositIdentity } from "../shared/inbox-readiness.ts";

const credential: InboxDepositCredential = {
  operatorId: "operator",
  inbox: { runRef: "run", groupId: "group" },
};

const identity: InboxDepositIdentity = {
  peerId: "peer",
  groupId: "group",
  instanceToken: "instance",
  inboxBinding: { runRef: "run", groupId: "group" },
  operatorId: "operator",
};

test("requires an identity confirmed by the matching operator, run and groups", () => {
  expect(inboxDepositReadiness(identity, credential)).toBeNull();

  for (const [label, changed] of [
    ["operator", { operatorId: "other-operator" }],
    ["run", { inboxBinding: { runRef: "other-run", groupId: "group" } }],
    ["binding group", { inboxBinding: { runRef: "run", groupId: "other-group" } }],
    ["identity group", { groupId: "other-group" }],
  ] as const) {
    expect(inboxDepositReadiness({ ...identity, ...changed }, credential), label).toBe("the confirmed Inbox registration does not match this run");
  }
});

test("refuses credentials without Inbox scope", () => {
  for (const credentialWithoutInbox of [
    { operatorId: "operator", inbox: null },
    { operatorId: "operator" },
  ] satisfies InboxDepositCredential[]) {
    expect(inboxDepositReadiness(identity, credentialWithoutInbox)).toBe("the run credential has no Inbox scope");
  }
});
