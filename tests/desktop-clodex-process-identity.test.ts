import { expect, test } from "bun:test";
import {
  parseOwnerRecord,
  sameOwner,
  type OwnerRecord
} from "../desktop/src/main/clodex-process-identity.ts";

const server = {
  host: "host",
  pid: 700,
  startedAt: 1_000,
  port: 4312
};

const windowsOwner = (): OwnerRecord => ({
  server,
  tree: {
    platform: "win32",
    root: { pid: 600, creationUtc: "2026-09-15T12:34:56.789Z" },
    runtime: { pid: 700, creationUtc: "2026-09-15T12:34:57.789Z" }
  }
});

const posixOwner = (): OwnerRecord => ({
  server,
  tree: {
    platform: "linux",
    root: { pid: 600, startToken: "418220" },
    runtime: { pid: 700, startToken: "418221" },
    pgid: 600
  }
});

test("parses complete Windows and POSIX tree owners", () => {
  const windows = windowsOwner();
  const linux = posixOwner();
  const darwin = { ...linux, tree: { ...linux.tree, platform: "darwin" as const } };

  expect(parseOwnerRecord(windows)).toEqual(windows);
  expect(parseOwnerRecord(linux)).toEqual(linux);
  expect(parseOwnerRecord(darwin)).toEqual(darwin);
});

test("accepts a Gregorian leap day, seven fractional digits, and the highest port", () => {
  const owner: OwnerRecord = {
    ...windowsOwner(),
    server: { ...server, port: 65_535 },
    tree: {
      platform: "win32",
      root: { pid: 600, creationUtc: "2024-02-29T12:34:56.1234567Z" },
      runtime: { pid: 700, creationUtc: "2024-02-29T12:34:57.1234567Z" }
    }
  };

  expect(parseOwnerRecord(owner)).toEqual(owner);
});

test("rejects legacy, malformed, and non-exact owner records", () => {
  const owner = windowsOwner();
  const invalid: unknown[] = [
    { server },
    { ...owner, tree: { ...owner.tree, platform: "freebsd" } },
    { ...owner, tree: { ...owner.tree, runtime: { ...owner.tree.runtime, pid: 701 } } },
    { ...owner, tree: { ...owner.tree, root: { pid: 0, creationUtc: owner.tree.root.creationUtc } } },
    { ...owner, tree: { ...owner.tree, runtime: { ...owner.tree.runtime, creationUtc: "2026-09-15" } } },
    {
      ...owner,
      tree: { ...owner.tree, runtime: { ...owner.tree.runtime, creationUtc: "2026-02-30T12:34:57.789Z" } }
    },
    {
      ...owner,
      tree: { ...owner.tree, runtime: { ...owner.tree.runtime, creationUtc: "2023-02-29T12:34:57.789Z" } }
    },
    { ...owner, extra: true },
    { ...posixOwner(), tree: { ...posixOwner().tree, pgid: 0 } },
    { ...posixOwner(), tree: { ...posixOwner().tree, runtime: { pid: 700, startToken: "" } } },
    { ...owner, server: { ...server, port: Number.NaN } },
    { ...owner, server: { ...server, port: 65_536 } }
  ];

  for (const value of invalid) {
    expect(parseOwnerRecord(value)).toBeNull();
  }
});

test("rejects divergent Windows stamps for a shared root and runtime PID", () => {
  const owner = windowsOwner();
  const divergent = {
    ...owner,
    tree: { ...owner.tree, root: { pid: 700, creationUtc: "2026-09-15T12:34:56.789Z" } }
  };

  expect(parseOwnerRecord(divergent)).toBeNull();
});

test("rejects divergent POSIX stamps for a shared root and runtime PID", () => {
  const owner = posixOwner();
  const divergent = {
    ...owner,
    tree: { ...owner.tree, root: { pid: 700, startToken: "different" }, pgid: 700 }
  };

  expect(parseOwnerRecord(divergent)).toBeNull();
});

test("allows a root process that is also the runtime process", () => {
  const owner = windowsOwner();
  const rootRuntime = {
    ...owner,
    tree: {
      ...owner.tree,
      root: { ...owner.tree.runtime }
    }
  };

  expect(parseOwnerRecord(rootRuntime)).toEqual(rootRuntime);
});

test("rejects a process group that is not the root process group", () => {
  const owner = posixOwner();
  const foreign: unknown[] = [
    { ...owner, tree: { ...owner.tree, pgid: 1 } },
    { ...owner, tree: { ...owner.tree, pgid: 999_999 } },
    { ...owner, tree: { ...owner.tree, pgid: owner.tree.runtime.pid } }
  ];

  for (const value of foreign) {
    expect(parseOwnerRecord(value)).toBeNull();
  }
  expect(parseOwnerRecord(owner)).toEqual(owner);
});

test("rejects an init process as the tree root", () => {
  const owner = posixOwner();
  const init = { ...owner, tree: { ...owner.tree, root: { pid: 1, startToken: "1" }, pgid: 1 } };

  expect(parseOwnerRecord(init)).toBeNull();
});

test("returns an owner copy that a later source mutation cannot reach", () => {
  const source = {
    server: { ...server },
    tree: {
      platform: "win32" as const,
      root: { pid: 600, creationUtc: "2026-09-15T12:34:56.789Z" },
      runtime: { pid: 700, creationUtc: "2026-09-15T12:34:57.789Z" }
    }
  };
  const parsed = parseOwnerRecord(source);
  if (!parsed || parsed.tree.platform !== "win32") throw new Error("expected a Windows owner");

  expect(parsed).toEqual(source);
  expect(parsed).not.toBe(source);
  expect(parsed.server).not.toBe(source.server);
  expect(parsed.tree).not.toBe(source.tree);
  expect(parsed.tree.root).not.toBe(source.tree.root);

  source.server.pid = 999;
  source.tree.root.creationUtc = "2026-09-15T23:59:59.999Z";
  expect(parsed.server.pid).toBe(700);
  expect(parsed.tree.root.creationUtc).toBe("2026-09-15T12:34:56.789Z");
});

test("compares the complete tree snapshot rather than only the server", () => {
  const owner = windowsOwner();
  const same = windowsOwner();
  const differentRoot = {
    ...windowsOwner(),
    tree: { ...windowsOwner().tree, root: { pid: 601, creationUtc: "2026-09-15T12:34:58.789Z" } }
  };
  const differentRuntimeStamp = {
    ...windowsOwner(),
    tree: {
      ...windowsOwner().tree,
      runtime: { pid: 700, creationUtc: "2026-09-15T12:34:58.789Z" }
    }
  };

  expect(sameOwner(owner, same)).toBe(true);
  expect(sameOwner(owner, differentRoot)).toBe(false);
  expect(sameOwner(owner, differentRuntimeStamp)).toBe(false);

  const posix = posixOwner();
  const differentPgid = { ...posixOwner(), tree: { ...posixOwner().tree, pgid: 601 } };
  expect(sameOwner(posix, posixOwner())).toBe(true);
  expect(sameOwner(posix, differentPgid)).toBe(false);
});
