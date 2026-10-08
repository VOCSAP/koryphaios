import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodePermissionLeaseDescriptor,
  encodePermissionLeaseDescriptor,
  PERMISSION_LEASE_FRESHNESS_MS,
  PERMISSION_LEASE_MAX_BYTES,
  parsePermissionLeaseDocument,
  type PermissionLeaseIdentity,
} from "../desktop/shared/permission-lease.ts";
import { PermissionLeaseRuntime } from "../desktop/src/main/permission-lease-runtime.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function identity(): PermissionLeaseIdentity {
  return {
    runId: randomUUID(),
    tileId: randomUUID(),
    launchId: randomUUID(),
  };
}

test("permission lease documents require their versioned identity and finite sequence", () => {
  const lease = identity();
  const document = {
    version: 1 as const,
    ...lease,
    sequence: 1,
    writtenAtMs: 123,
  };

  expect(parsePermissionLeaseDocument(JSON.stringify(document))).toEqual(document);
  expect(parsePermissionLeaseDocument(JSON.stringify({ ...document, padding: "x".repeat(PERMISSION_LEASE_MAX_BYTES) }))).toBeNull();
  expect(parsePermissionLeaseDocument(JSON.stringify({ ...document, sequence: Number.NaN }))).toBeNull();
  expect(parsePermissionLeaseDocument(JSON.stringify({ ...document, launchId: "not-a-uuid" }))).toBeNull();

  const descriptor = encodePermissionLeaseDescriptor({ file: "C:/state/lease.json", ...lease });
  expect(decodePermissionLeaseDescriptor(descriptor)).toEqual({ file: "C:/state/lease.json", ...lease });
  expect(decodePermissionLeaseDescriptor(JSON.stringify({ file: "lease.json", ...lease }))).toBeNull();
});

test("an old launch timer cannot pulse or delete its replacement lease", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "permission-lease-"));
  tempDirs.push(stateDir);
  const ticks: Array<() => void> = [];
  const runtime = new PermissionLeaseRuntime({
    stateDir,
    runId: randomUUID(),
    setInterval: (tick) => {
      ticks.push(tick);
      return tick;
    },
    clearInterval: () => {},
    reportError: () => {},
  });
  const tileId = randomUUID();

  const first = runtime.createLease(tileId);
  const firstDocument = parsePermissionLeaseDocument(readFileSync(first.file, "utf8"));
  expect(firstDocument?.sequence).toBe(1);

  ticks[0]!();
  expect(parsePermissionLeaseDocument(readFileSync(first.file, "utf8"))?.sequence).toBe(2);

  const second = runtime.createLease(tileId);
  expect(parsePermissionLeaseDocument(readFileSync(second.file, "utf8"))?.sequence).toBe(1);

  ticks[0]!();
  runtime.revoke(first);
  expect(parsePermissionLeaseDocument(readFileSync(second.file, "utf8"))?.sequence).toBe(1);

  runtime.revoke(second);
  expect(() => readFileSync(second.file, "utf8")).toThrow();
});

test("an initial lease write failure removes its temporary file", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "permission-lease-"));
  tempDirs.push(stateDir);
  let temporary = "";
  const runtime = new PermissionLeaseRuntime({
    stateDir,
    runId: randomUUID(),
    rename: (from) => {
      temporary = from;
      throw new Error("lease file locked");
    },
    reportError: () => {},
  });

  expect(() => runtime.createLease(randomUUID())).toThrow("lease file locked");
  expect(existsSync(temporary)).toBe(false);
});

test.each(["EPERM", "EBUSY", "EACCES"])("a transient %s pulse failure preserves a lease until a later pulse succeeds", (code) => {
  const stateDir = mkdtempSync(join(tmpdir(), "permission-lease-"));
  tempDirs.push(stateDir);
  const ticks: Array<() => void> = [];
  const reports: Array<[string, unknown]> = [];
  let renameCalls = 0;
  const runtime = new PermissionLeaseRuntime({
    stateDir,
    runId: randomUUID(),
    now: () => 1_000,
    setInterval: (tick) => {
      ticks.push(tick);
      return tick;
    },
    clearInterval: () => {},
    rename: (from, to) => {
      renameCalls++;
      if (renameCalls === 2) {
        const error = new Error("lease file locked") as Error & { code: string };
        error.code = code;
        throw error;
      }
      renameSync(from, to);
    },
    reportError: (message, error) => reports.push([message, error]),
  });
  const lease = runtime.createLease(randomUUID());

  ticks[0]!();
  expect(parsePermissionLeaseDocument(readFileSync(lease.file, "utf8"))?.sequence).toBe(1);
  ticks[0]!();
  expect(parsePermissionLeaseDocument(readFileSync(lease.file, "utf8"))?.sequence).toBe(2);
  expect(reports).toHaveLength(1);
});

test("persistent pulse failures revoke a lease after its freshness window", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "permission-lease-"));
  tempDirs.push(stateDir);
  const ticks: Array<() => void> = [];
  let now = 1_000;
  let renameCalls = 0;
  const runtime = new PermissionLeaseRuntime({
    stateDir,
    runId: randomUUID(),
    now: () => now,
    setInterval: (tick) => {
      ticks.push(tick);
      return tick;
    },
    clearInterval: () => {},
    rename: (from, to) => {
      if (renameCalls > 0) {
        const error = new Error("lease file locked") as Error & { code: string };
        error.code = "EBUSY";
        throw error;
      }
      renameCalls++;
      renameSync(from, to);
    },
    reportError: () => {},
  });
  const lease = runtime.createLease(randomUUID());

  now += PERMISSION_LEASE_FRESHNESS_MS + 1;
  ticks[0]!();
  expect(() => readFileSync(lease.file, "utf8")).toThrow();
  expect(existsSync(`${lease.file}.2.tmp`)).toBe(false);
});
