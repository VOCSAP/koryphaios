export interface InboxDepositIdentity {
  peerId: string | null;
  groupId: string;
  instanceToken: string | null;
  inboxBinding: { runRef: string; groupId: string } | null;
  operatorId: string | null;
}

export interface InboxDepositCredential {
  operatorId: string;
  inbox?: { runRef: string; groupId: string } | null;
}

export function inboxDepositReadiness(identity: InboxDepositIdentity, credential: InboxDepositCredential): string | null {
  if (!credential.inbox) return "the run credential has no Inbox scope";
  if (!identity.peerId || !identity.instanceToken || !identity.inboxBinding || !identity.operatorId) {
    return "Inbox registration is not yet confirmed";
  }
  if (
    identity.operatorId !== credential.operatorId ||
    identity.inboxBinding.runRef !== credential.inbox.runRef ||
    identity.inboxBinding.groupId !== credential.inbox.groupId ||
    identity.groupId !== credential.inbox.groupId
  ) {
    return "the confirmed Inbox registration does not match this run";
  }
  return null;
}
