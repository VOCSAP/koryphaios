// Single import point for the approval crypto in the Deck's main process.
//
// It deliberately RE-EXPORTS the core module (repo-root `shared/approval.ts`)
// rather than mirroring it, unlike broker-client.ts which had to re-implement
// shared/config.ts. The reason that mirror exists does not apply here:
// shared/config.ts uses `Bun.file`, unavailable under Electron, whereas
// shared/approval.ts uses node:crypto only and runs unchanged in Electron, in
// Bun and in a hook subprocess.
//
// Mirroring would be actively dangerous for this particular file: a drift of a
// single byte in the canonical serialization or a domain-separation string
// silently invalidates every signature between the Deck and the broker. One
// implementation, one behaviour.

export {
  APPROVAL_ANSWER_MAX,
  APPROVAL_AUTH_SKEW_SEC,
  APPROVAL_QUESTION_MAX,
  APPROVAL_TITLE_MAX,
  APPROVAL_WAIT_MAX_SEC,
  buildAuthProof,
  canonicalize,
  deriveOperatorId,
  deriveTokenId,
  generateCredential,
  generateSecret,
  isOperationAllowed,
  sanitizeAnswerForPty,
  stripControl,
  validateApprovalDraft,
  verifyAuthProof,
  type Approval,
  type ApprovalAnswerKind,
  type ApprovalAuthKind,
  type ApprovalAuthProof,
  type ApprovalCredential,
  type ApprovalKind,
  type ApprovalOrigin,
  type ApprovalStatus,
  type ApprovalVia
} from '../../../shared/approval'
