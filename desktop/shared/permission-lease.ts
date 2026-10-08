import { isAbsolute } from "node:path";

export const PERMISSION_LEASE_VERSION = 1;
export const PERMISSION_LEASE_MAX_BYTES = 4096;
export const PERMISSION_LEASE_FRESHNESS_MS = 10_000;

export interface PermissionLeaseIdentity {
  runId: string;
  tileId: string;
  launchId: string;
}

export interface PermissionLeaseDocument extends PermissionLeaseIdentity {
  version: typeof PERMISSION_LEASE_VERSION;
  sequence: number;
  writtenAtMs: number;
}

export interface PermissionLeaseDescriptor extends PermissionLeaseIdentity {
  file: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isIdentity(value: Record<string, unknown>): value is Record<string, unknown> & PermissionLeaseIdentity {
  return isUuid(value.runId) && isUuid(value.tileId) && isUuid(value.launchId);
}

function parse(value: string): Record<string, unknown> | null {
  if (Buffer.byteLength(value, "utf8") > PERMISSION_LEASE_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function encodePermissionLeaseDescriptor(descriptor: PermissionLeaseDescriptor): string {
  return JSON.stringify(descriptor);
}

export function decodePermissionLeaseDescriptor(value: string | undefined): PermissionLeaseDescriptor | null {
  if (!value) return null;
  const parsed = parse(value);
  if (!parsed || !isIdentity(parsed) || typeof parsed.file !== "string" || !isAbsolute(parsed.file)) return null;
  return { file: parsed.file, runId: parsed.runId, tileId: parsed.tileId, launchId: parsed.launchId };
}

export function parsePermissionLeaseDocument(value: string): PermissionLeaseDocument | null {
  const parsed = parse(value);
  if (!parsed || !isIdentity(parsed) || parsed.version !== PERMISSION_LEASE_VERSION) return null;
  const { sequence, writtenAtMs } = parsed;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof writtenAtMs !== "number" ||
    !Number.isFinite(writtenAtMs) ||
    writtenAtMs < 0
  ) {
    return null;
  }
  return {
    version: PERMISSION_LEASE_VERSION,
    runId: parsed.runId,
    tileId: parsed.tileId,
    launchId: parsed.launchId,
    sequence,
    writtenAtMs,
  };
}

export function samePermissionLeaseIdentity(
  left: PermissionLeaseIdentity,
  right: PermissionLeaseIdentity
): boolean {
  return left.runId === right.runId && left.tileId === right.tileId && left.launchId === right.launchId;
}
