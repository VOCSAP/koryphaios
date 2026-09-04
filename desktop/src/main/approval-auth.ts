// Re-exports shared/approval.ts rather than mirroring it: that module only uses
// node:crypto, so it runs unchanged under Electron, Bun and a hook subprocess.
// A byte of drift in the canonical serialization or domain-separation string
// would silently invalidate every signature between the Deck and the broker, so
// mirroring here would be dangerous.

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
  type ApprovalAddResponse,
  type ApprovalAnswerKind,
  type ApprovalAuthKind,
  type ApprovalAuthProof,
  type ApprovalCredential,
  type ApprovalKind,
  type ApprovalOrigin,
  type ApprovalStatus,
  type ApprovalVia
} from '../../../shared/approval'
