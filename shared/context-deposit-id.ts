const DEPOSIT_ID = /^[0-9a-f]{16}$/;

export function isDepositIdShape(value: unknown): value is string {
  return typeof value === "string" && DEPOSIT_ID.test(value);
}
