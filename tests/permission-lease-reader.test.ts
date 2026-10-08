import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { encodePermissionLeaseDescriptor } from "../desktop/shared/permission-lease.ts";
import { createPermissionLeaseReader } from "../desktop/hooks/permission-lease.ts";

const LEASE_FILE = "/state/lease.json";

test("the lease fixture path is absolute on POSIX and Windows", () => {
  expect(posix.isAbsolute(LEASE_FILE)).toBe(true);
  expect(win32.isAbsolute(LEASE_FILE)).toBe(true);
});

function document(sequence: number, writtenAtMs: number) {
  return {
    version: 1 as const,
    runId: randomUUID(),
    tileId: randomUUID(),
    launchId: randomUUID(),
    sequence,
    writtenAtMs,
  };
}

test("a permission lease is admitted only after its sequence advances", async () => {
  let wallNow = 1_000;
  let monotonicNow = 10;
  let current = document(1, wallNow);
  const ticks: Array<() => void> = [];
  const descriptor = encodePermissionLeaseDescriptor({ file: LEASE_FILE, ...current });
  const reader = createPermissionLeaseReader(descriptor, {
    readFile: () => JSON.stringify(current),
    wallNow: () => wallNow,
    monotonicNow: () => monotonicNow,
    setInterval: (tick) => {
      ticks.push(tick);
      return tick;
    },
    clearInterval: () => {},
    reportError: () => {},
  });

  expect(reader).not.toBeNull();
  const admitted = reader!.waitForAdmission();
  ticks[0]!();
  current = { ...current, sequence: 2, writtenAtMs: wallNow };
  ticks[0]!();
  expect(await admitted).toBe(true);

  current = { ...current, runId: randomUUID(), sequence: 3 };
  ticks[0]!();
  expect(reader!.signal.aborted).toBe(true);

  current = { ...current, runId: JSON.parse(descriptor).runId, sequence: 4 };
  ticks[0]!();
  expect(reader!.isActive()).toBe(false);
});

test("a lease read failure is reported once before the reader aborts", () => {
  let reads = 0;
  const current = document(1, 1_000);
  const descriptor = encodePermissionLeaseDescriptor({ file: LEASE_FILE, ...current });
  const ticks: Array<() => void> = [];
  const failure = new Error("access denied");
  const reports: Array<[string, unknown]> = [];
  const reader = createPermissionLeaseReader(descriptor, {
    readFile: () => {
      reads++;
      if (reads === 1) return JSON.stringify(current);
      throw failure;
    },
    wallNow: () => 1_000,
    monotonicNow: () => 10,
    setInterval: (tick) => {
      ticks.push(tick);
      return tick;
    },
    clearInterval: () => {},
    reportError: (message, error) => reports.push([message, error]),
  });

  ticks[0]!();
  ticks[0]!();

  expect(reader?.signal.aborted).toBe(true);
  expect(reports).toEqual([["permission lease read failed", failure]]);
});

test("an initial lease read failure is reported before rejection", () => {
  const lease = document(1, 1_000);
  const failure = new Error("access denied");
  const reports: Array<[string, unknown]> = [];

  const reader = createPermissionLeaseReader(
    encodePermissionLeaseDescriptor({ file: LEASE_FILE, ...lease }),
    {
      readFile: () => {
        throw failure;
      },
      reportError: (message, error) => reports.push([message, error]),
    }
  );

  expect(reader).toBeNull();
  expect(reports).toEqual([["permission lease read failed", failure]]);
});

test.each([
  ["missing", () => null],
  ["invalid JSON", () => "not JSON"],
  ["stale", (current: ReturnType<typeof document>) => JSON.stringify({ ...current, writtenAtMs: 9_999 })],
  ["future", (current: ReturnType<typeof document>) => JSON.stringify({ ...current, writtenAtMs: 20_001 })],
  ["regressive", (current: ReturnType<typeof document>) => JSON.stringify({ ...current, sequence: 1 })],
])("a %s lease stops permanently before admission", async (_name, invalid) => {
  const initial = document(2, 20_000);
  const descriptor = encodePermissionLeaseDescriptor({ file: LEASE_FILE, ...initial });
  let raw: string | null = JSON.stringify(initial);
  const ticks: Array<() => void> = [];
  const reader = createPermissionLeaseReader(descriptor, {
    readFile: () => {
      if (raw === null) throw new Error("lease missing");
      return raw;
    },
    wallNow: () => 20_000,
    monotonicNow: () => 10,
    setInterval: (tick) => {
      ticks.push(tick);
      return tick;
    },
    clearInterval: () => {},
    reportError: () => {},
  });

  expect(reader).not.toBeNull();
  const admission = reader!.waitForAdmission();
  raw = invalid(initial);
  ticks[0]!();

  expect(reader!.signal.aborted).toBe(true);
  expect(await admission).toBe(false);
  raw = JSON.stringify({ ...initial, sequence: 3 });
  ticks[0]!();
  expect(reader!.isActive()).toBe(false);
});

test.each([
  ["stale", 9_999],
  ["future", 20_001],
])("an initial %s lease is rejected", (_name, writtenAtMs) => {
  const initial = document(1, writtenAtMs);
  const reader = createPermissionLeaseReader(
    encodePermissionLeaseDescriptor({ file: LEASE_FILE, ...initial }),
    {
      readFile: () => JSON.stringify(initial),
      wallNow: () => 20_000,
      reportError: () => {},
    }
  );

  expect(reader).toBeNull();
});

test("a lease with no pulse expires from the reader's monotonic clock", () => {
  let monotonicNow = 10;
  const current = document(1, 1_000);
  const ticks: Array<() => void> = [];
  const reader = createPermissionLeaseReader(
    encodePermissionLeaseDescriptor({ file: LEASE_FILE, ...current }),
    {
      readFile: () => JSON.stringify(current),
      wallNow: () => 1_000,
      monotonicNow: () => monotonicNow,
      setInterval: (tick) => {
        ticks.push(tick);
        return tick;
      },
      clearInterval: () => {},
      reportError: () => {},
    }
  );

  monotonicNow += 10_001;
  ticks[0]!();
  expect(reader?.signal.aborted).toBe(true);
});
