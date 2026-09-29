import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeCwdKey,
  deskSessionFileName,
  isPeerIdCacheEnabled,
  sanitizeSessionId,
  writeDeskSessionId,
  writePeerIdCache,
} from "../shared/peer-cache";

const ENABLED_ENV = { CLAUDE_PEERS_STATUS_LINE_CACHE: "1" };

describe("computeCwdKey", () => {
  test("short path is sanitized verbatim (matches MSYS2 fallback)", () => {
    expect(computeCwdKey("/foo/bar")).toBe("_foo_bar");
  });

  test("path longer than 40 chars is truncated to last 40", () => {
    const cwd = "/very/long/path/" + "x".repeat(60);
    const key = computeCwdKey(cwd);
    expect(key.length).toBe(40);
    expect(key).toBe(cwd.replace(/[^a-zA-Z0-9-]/g, "_").slice(-40));
  });

  test("preserves alphanumerics and hyphens, replaces all else with _", () => {
    expect(computeCwdKey("D:\\AI\\MCPServer\\claude-peers-mcp")).toBe(
      "D__AI_MCPServer_claude-peers-mcp",
    );
  });

  test("path exactly 40 chars after sanitization is returned verbatim", () => {
    const s = "a".repeat(40);
    expect(computeCwdKey(s)).toBe(s);
  });

  test("path 41 chars after sanitization keeps trailing 40", () => {
    const s = "a" + "b".repeat(40);
    expect(computeCwdKey(s)).toBe("b".repeat(40));
  });
});

describe("writePeerIdCache", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "cp-cache-"));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("writes peer_id to ~/.claude/peers/peer-id-<key>.txt", async () => {
    await writePeerIdCache("D:\\AI\\MCPServer\\claude-peers-mcp", "test-peer-1", tmpHome, ENABLED_ENV);
    const expected = join(
      tmpHome,
      ".claude",
      "peers",
      "peer-id-D__AI_MCPServer_claude-peers-mcp.txt",
    );
    expect(await readFile(expected, "utf-8")).toBe("test-peer-1");
  });

  test("creates parent directory recursively when missing", async () => {
    await writePeerIdCache("/foo/bar", "peer-x", tmpHome, ENABLED_ENV);
    const dir = join(tmpHome, ".claude", "peers");
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await readFile(join(dir, "peer-id-_foo_bar.txt"), "utf-8")).toBe("peer-x");
  });

  test("overwrites an existing stale value", async () => {
    await writePeerIdCache("/repo", "old-peer", tmpHome, ENABLED_ENV);
    await writePeerIdCache("/repo", "new-peer", tmpHome, ENABLED_ENV);
    const file = join(tmpHome, ".claude", "peers", "peer-id-_repo.txt");
    expect(await readFile(file, "utf-8")).toBe("new-peer");
  });

  test("silently swallows errors when home is unwritable", async () => {
    // An invalid home path must not throw -- best-effort cache.
    await expect(
      writePeerIdCache("/foo", "peer-y", "\0not-a-real-home", ENABLED_ENV),
    ).resolves.toBeUndefined();
  });

  test("is a no-op when env var is unset (opt-in by default)", async () => {
    await writePeerIdCache("/foo/bar", "peer-z", tmpHome, {});
    // No file should be written, no directory should be created.
    await expect(stat(join(tmpHome, ".claude"))).rejects.toThrow();
  });

  test("is a no-op when env var is set to a falsy string", async () => {
    await writePeerIdCache("/foo/bar", "peer-z", tmpHome, { CLAUDE_PEERS_STATUS_LINE_CACHE: "0" });
    await expect(stat(join(tmpHome, ".claude"))).rejects.toThrow();
  });

  test("suffixes filename with CLAUDE_CODE_SESSION_ID when present", async () => {
    await writePeerIdCache("/repo", "peer-A", tmpHome, {
      ...ENABLED_ENV,
      CLAUDE_CODE_SESSION_ID: "23c2dc97-d254-4ec8-9cd9-8bc0b4ad3ba1",
    });
    const file = join(
      tmpHome,
      ".claude",
      "peers",
      "peer-id-_repo-23c2dc97-d254-4ec8-9cd9-8bc0b4ad3ba1.txt",
    );
    expect(await readFile(file, "utf-8")).toBe("peer-A");
  });

  test("two sessions in the same cwd keep distinct cache files", async () => {
    await writePeerIdCache("/repo", "peer-1", tmpHome, {
      ...ENABLED_ENV,
      CLAUDE_CODE_SESSION_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
    await writePeerIdCache("/repo", "peer-2", tmpHome, {
      ...ENABLED_ENV,
      CLAUDE_CODE_SESSION_ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });
    const dir = join(tmpHome, ".claude", "peers");
    expect(
      await readFile(join(dir, "peer-id-_repo-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.txt"), "utf-8"),
    ).toBe("peer-1");
    expect(
      await readFile(join(dir, "peer-id-_repo-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.txt"), "utf-8"),
    ).toBe("peer-2");
  });

  test("falls back to legacy filename when CLAUDE_CODE_SESSION_ID is empty", async () => {
    await writePeerIdCache("/repo", "peer-legacy", tmpHome, {
      ...ENABLED_ENV,
      CLAUDE_CODE_SESSION_ID: "",
    });
    const file = join(tmpHome, ".claude", "peers", "peer-id-_repo.txt");
    expect(await readFile(file, "utf-8")).toBe("peer-legacy");
  });

  test("sanitizes session id with unsafe chars before writing", async () => {
    await writePeerIdCache("/repo", "peer-S", tmpHome, {
      ...ENABLED_ENV,
      CLAUDE_CODE_SESSION_ID: "abc/../etc",
    });
    const file = join(tmpHome, ".claude", "peers", "peer-id-_repo-abc____etc.txt");
    expect(await readFile(file, "utf-8")).toBe("peer-S");
  });
});

describe("deskSessionFileName", () => {
  test("formats desk-session-<sanitized-token>.txt", () => {
    expect(deskSessionFileName("tile-123")).toBe("desk-session-tile-123.txt");
    expect(deskSessionFileName("a/b c")).toBe("desk-session-a_b_c.txt");
  });
});

describe("writeDeskSessionId", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "cp-desk-"));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  const file = (home: string, token: string): string =>
    join(home, ".claude", "peers", `desk-session-${token}.txt`);
  const sidIn = async (home: string, token: string): Promise<string> =>
    (JSON.parse(await readFile(file(home, token), "utf-8")) as { sid: string }).sid;

  test("writes the real session id to desk-session-<token>.txt, tagged as a register write", async () => {
    await writeDeskSessionId(tmpHome, {
      CLAUDE_PEERS_DESK_SESSION: "tile-A",
      CLAUDE_CODE_SESSION_ID: "23c2dc97-d254-4ec8-9cd9-8bc0b4ad3ba1",
    });
    expect(JSON.parse(await readFile(file(tmpHome, "tile-A"), "utf-8"))).toEqual({
      sid: "23c2dc97-d254-4ec8-9cd9-8bc0b4ad3ba1",
      source: "register",
    });
  });

  test("is a no-op when the token (CLAUDE_PEERS_DESK_SESSION) is unset", async () => {
    await writeDeskSessionId(tmpHome, { CLAUDE_CODE_SESSION_ID: "abc" });
    await expect(stat(join(tmpHome, ".claude"))).rejects.toThrow();
  });

  test("is a no-op when CLAUDE_CODE_SESSION_ID is unset/empty (no garbage id)", async () => {
    await writeDeskSessionId(tmpHome, { CLAUDE_PEERS_DESK_SESSION: "tile-A", CLAUDE_CODE_SESSION_ID: "" });
    await expect(stat(join(tmpHome, ".claude"))).rejects.toThrow();
  });

  test("overwrites a stale id (resume captures the fresh minted id)", async () => {
    await writeDeskSessionId(tmpHome, { CLAUDE_PEERS_DESK_SESSION: "t", CLAUDE_CODE_SESSION_ID: "old-id" });
    await writeDeskSessionId(tmpHome, { CLAUDE_PEERS_DESK_SESSION: "t", CLAUDE_CODE_SESSION_ID: "new-id" });
    expect(await sidIn(tmpHome, "t")).toBe("new-id");
  });

  test("sanitizes an unsafe token before using it as a filename", async () => {
    await writeDeskSessionId(tmpHome, {
      CLAUDE_PEERS_DESK_SESSION: "a/../b",
      CLAUDE_CODE_SESSION_ID: "real",
    });
    expect(await sidIn(tmpHome, "a____b")).toBe("real");
  });

  test("two tiles in the same cwd keep distinct token files (D1 fix)", async () => {
    await writeDeskSessionId(tmpHome, { CLAUDE_PEERS_DESK_SESSION: "tileA", CLAUDE_CODE_SESSION_ID: "id-A" });
    await writeDeskSessionId(tmpHome, { CLAUDE_PEERS_DESK_SESSION: "tileB", CLAUDE_CODE_SESSION_ID: "id-B" });
    expect(await sidIn(tmpHome, "tileA")).toBe("id-A");
    expect(await sidIn(tmpHome, "tileB")).toBe("id-B");
  });

  test("silently swallows errors when home is unwritable", async () => {
    await expect(
      writeDeskSessionId("\0not-a-real-home", {
        CLAUDE_PEERS_DESK_SESSION: "t",
        CLAUDE_CODE_SESSION_ID: "id",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("sanitizeSessionId", () => {
  test("returns empty string for undefined/null/empty", () => {
    expect(sanitizeSessionId(undefined)).toBe("");
    expect(sanitizeSessionId(null)).toBe("");
    expect(sanitizeSessionId("")).toBe("");
  });

  test("passes UUID v4 through unchanged", () => {
    expect(sanitizeSessionId("23c2dc97-d254-4ec8-9cd9-8bc0b4ad3ba1")).toBe(
      "23c2dc97-d254-4ec8-9cd9-8bc0b4ad3ba1",
    );
  });

  test("replaces non [A-Za-z0-9-] chars with underscore", () => {
    expect(sanitizeSessionId("abc/../etc")).toBe("abc____etc");
    expect(sanitizeSessionId("with spaces")).toBe("with_spaces");
  });

  test("caps length at 64 chars", () => {
    const long = "a".repeat(200);
    expect(sanitizeSessionId(long).length).toBe(64);
  });
});

describe("isPeerIdCacheEnabled", () => {
  test("returns false when env var is unset", () => {
    expect(isPeerIdCacheEnabled({})).toBe(false);
  });

  test.each([["1"], ["true"], ["TRUE"], ["yes"], ["on"], ["On"]])(
    "returns true for truthy value %s",
    (value) => {
      expect(isPeerIdCacheEnabled({ CLAUDE_PEERS_STATUS_LINE_CACHE: value })).toBe(true);
    },
  );

  test.each([["0"], ["false"], ["no"], ["off"], [""], ["bogus"]])(
    "returns false for falsy value %s",
    (value) => {
      expect(isPeerIdCacheEnabled({ CLAUDE_PEERS_STATUS_LINE_CACHE: value })).toBe(false);
    },
  );
});
