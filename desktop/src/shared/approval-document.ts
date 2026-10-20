export interface ApprovalDocument {
  readonly message: string
  readonly detail: string
  readonly approve: string
  readonly refuse: string
  readonly close: string
  readonly showFile?: string
}
