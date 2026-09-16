export interface ServerIdentity {
  host: string;
  pid: number;
  startedAt: number;
  port: number;
}

export interface WindowsProcessStamp {
  pid: number;
  creationUtc: string;
}

export interface PosixProcessStamp {
  pid: number;
  startToken: string;
}

export type ClodexTreeIdentity =
  | {
      platform: "win32";
      root: WindowsProcessStamp;
      runtime: WindowsProcessStamp;
    }
  | {
      platform: "linux" | "darwin";
      root: PosixProcessStamp;
      runtime: PosixProcessStamp;
      pgid: number;
    };

export interface OwnerRecord {
  server: ServerIdentity;
  tree: ClodexTreeIdentity;
}

const MAX_HOST_LENGTH = 255;
const MAX_STAMP_LENGTH = 256;
const UTC_CREATION_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{1,9})Z$/;

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STAMP_LENGTH;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isUtcCreationStamp(value: string): boolean {
  const match = UTC_CREATION_STAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || year > 9_999 || month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function isServerIdentity(value: unknown): value is ServerIdentity {
  return (
    isExactRecord(value, ["host", "pid", "startedAt", "port"]) &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    value.host.length <= MAX_HOST_LENGTH &&
    isPositiveInteger(value.pid) &&
    isPositiveInteger(value.startedAt) &&
    isPort(value.port)
  );
}

function isWindowsStamp(value: unknown): value is WindowsProcessStamp {
  return (
    isExactRecord(value, ["pid", "creationUtc"]) &&
    isPositiveInteger(value.pid) &&
    isBoundedString(value.creationUtc) &&
    isUtcCreationStamp(value.creationUtc)
  );
}

function isPosixStamp(value: unknown): value is PosixProcessStamp {
  return isExactRecord(value, ["pid", "startToken"]) && isPositiveInteger(value.pid) && isBoundedString(value.startToken);
}

function parseTreeIdentity(value: unknown): ClodexTreeIdentity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const tree = value as Record<string, unknown>;
  if (tree.platform === "win32") {
    if (!isExactRecord(tree, ["platform", "root", "runtime"])) return null;
    if (!isWindowsStamp(tree.root) || !isWindowsStamp(tree.runtime)) return null;
    if (tree.root.pid === tree.runtime.pid && tree.root.creationUtc !== tree.runtime.creationUtc) return null;
    return {
      platform: "win32",
      root: { pid: tree.root.pid, creationUtc: tree.root.creationUtc },
      runtime: { pid: tree.runtime.pid, creationUtc: tree.runtime.creationUtc }
    };
  }
  if (tree.platform === "linux" || tree.platform === "darwin") {
    if (!isExactRecord(tree, ["platform", "root", "runtime", "pgid"])) return null;
    if (!isPosixStamp(tree.root) || !isPosixStamp(tree.runtime) || !isPositiveInteger(tree.pgid)) return null;
    if (tree.root.pid === tree.runtime.pid && tree.root.startToken !== tree.runtime.startToken) return null;
    // A detached spawn calls setsid, so the group equals the root pid; a looser `pgid > 1`
    // would still let a record aim kill(-pgid) at a group that was never ours.
    if (tree.pgid !== tree.root.pid) return null;
    // A spawned child is never pid 1, so such a record can only name the init group.
    if (tree.root.pid === 1) return null;
    return {
      platform: tree.platform,
      root: { pid: tree.root.pid, startToken: tree.root.startToken },
      runtime: { pid: tree.runtime.pid, startToken: tree.runtime.startToken },
      pgid: tree.pgid
    };
  }
  return null;
}

/** Returns a detached copy: the caller may retain it while the source keeps mutating. */
export function parseOwnerRecord(value: unknown): OwnerRecord | null {
  if (!isExactRecord(value, ["server", "tree"])) return null;
  if (!isServerIdentity(value.server)) return null;
  const tree = parseTreeIdentity(value.tree);
  if (!tree || tree.runtime.pid !== value.server.pid) return null;
  const { host, pid, startedAt, port } = value.server;
  return { server: { host, pid, startedAt, port }, tree };
}

export function sameOwner(left: OwnerRecord, right: OwnerRecord): boolean {
  if (
    left.server.host !== right.server.host ||
    left.server.pid !== right.server.pid ||
    left.server.startedAt !== right.server.startedAt ||
    left.server.port !== right.server.port ||
    left.tree.platform !== right.tree.platform
  ) {
    return false;
  }
  if (left.tree.platform === "win32" && right.tree.platform === "win32") {
    return (
      left.tree.root.pid === right.tree.root.pid &&
      left.tree.root.creationUtc === right.tree.root.creationUtc &&
      left.tree.runtime.pid === right.tree.runtime.pid &&
      left.tree.runtime.creationUtc === right.tree.runtime.creationUtc
    );
  }
  if (left.tree.platform === "win32" || right.tree.platform === "win32") return false;
  return (
    left.tree.root.pid === right.tree.root.pid &&
    left.tree.root.startToken === right.tree.root.startToken &&
    left.tree.runtime.pid === right.tree.runtime.pid &&
    left.tree.runtime.startToken === right.tree.runtime.startToken &&
    left.tree.pgid === right.tree.pgid
  );
}
