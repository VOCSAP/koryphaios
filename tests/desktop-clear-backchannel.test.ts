// Fix for the /clear restore-session loss (spec_fa2a7e82). Covers the two pure
// pieces of the fix: the SessionStart hook's id derivation, the shared
// back-channel writer, and -- via the real readDeskSessionId/transcriptExists
// building blocks -- the save-time adoption signal that SessionService.
// refreshLiveSessionIds relies on (SessionService itself is not bun-testable
// because it pulls node-pty).

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveSessionId, deriveSessionSource, SESSION_START_SOURCES } from "../desktop/hooks/desk-backchannel-hook.ts";
import { writeDeskSessionFile, deskSessionFileName } from "../shared/peer-cache.ts";
import {
  DESK_SESSION_SOURCES,
  liveRotationId,
  readDeskSession,
  readDeskSessionId,
} from "../desktop/src/main/desk-session.ts";
import { transcriptExists, encodeProjectDir } from "../desktop/src/main/session-transcript.ts";

const tmpDirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-clearbc-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("deriveSessionId (hook)", () => {
  test("prefers the transcript basename over session_id", () => {
    expect(
      deriveSessionId({
        transcript_path: "/home/o/.claude/projects/p/0f79f2b1-941a-4786-96a5-8db35a454012.jsonl",
        session_id: "ignored",
      }),
    ).toBe("0f79f2b1-941a-4786-96a5-8db35a454012");
  });

  test("handles a Windows backslash transcript_path under a posix path module", () => {
    expect(
      deriveSessionId({
        transcript_path: "C:\\Users\\dev\\.claude\\projects\\p\\26bbec1f-c8fe-42a3.jsonl",
      }),
    ).toBe("26bbec1f-c8fe-42a3");
  });

  test("strips .jsonl case-insensitively", () => {
    expect(deriveSessionId({ transcript_path: "/p/abc-1.JSONL" })).toBe("abc-1");
  });

  test("falls back to session_id when transcript_path is absent", () => {
    expect(deriveSessionId({ session_id: "sid-9" })).toBe("sid-9");
  });

  test("returns empty string when neither field is usable", () => {
    expect(deriveSessionId({})).toBe("");
    expect(deriveSessionId({ transcript_path: "   ", session_id: "  " })).toBe("");
  });
});

describe("deriveSessionSource (hook)", () => {
  test("carries the SessionStart source of the payload", () => {
    for (const source of ["startup", "resume", "clear", "compact"] as const) {
      expect(deriveSessionSource({ source })).toBe(source);
    }
  });

  test("the Deck reader knows exactly the hook's sources plus register", () => {
    const expected = new Set([...SESSION_START_SOURCES, "register"]);
    expect([...DESK_SESSION_SOURCES].sort()).toEqual([...expected].sort());
    expect(SESSION_START_SOURCES.has("register"), "register is server.ts' source, never the hook's").toBe(false);
  });

  test("reads a missing or unknown source as startup, never as a rotation", () => {
    expect(deriveSessionSource({})).toBe("startup");
    expect(deriveSessionSource({ source: "clear!" as never })).toBe("startup");
  });
});

describe("writeDeskSessionFile", () => {
  test("writes the id and its source to desk-session-<token>.txt", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("tile-A", { sid: "id-123", source: "clear" }, home);
    const f = join(home, ".claude", "peers", deskSessionFileName("tile-A"));
    expect(existsSync(f)).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf-8"))).toEqual({ sid: "id-123", source: "clear" });
  });

  test("is a no-op when token is empty", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("", { sid: "id-123", source: "register" }, home);
    expect(existsSync(join(home, ".claude", "peers"))).toBe(false);
  });

  test("is a no-op when id is empty/whitespace", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("tile-A", { sid: "   ", source: "register" }, home);
    const f = join(home, ".claude", "peers", deskSessionFileName("tile-A"));
    expect(existsSync(f)).toBe(false);
  });

  test("round-trips through the Deck reader (readDeskSession)", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("tile-X", { sid: "minted-42", source: "compact" }, home);
    const peers = join(home, ".claude", "peers");
    expect(readDeskSessionId("tile-X", peers)).toBe("minted-42");
    expect(readDeskSession("tile-X", peers)).toEqual({ sid: "minted-42", source: "compact" });
  });
});

describe("save-time adoption signal (refreshLiveSessionIds building blocks)", () => {
  const CWD = "D:\\AI\\MCPServer\\claude-peers-mcp";
  const TOKEN = "tile-42";

  // Mirror of the refreshLiveSessionIds predicate, fed by the real readers, so
  // the test exercises the exact condition the service uses.
  function wouldAdopt(home: string, currentId: string, adoptedSinceSpawn = true): string | null {
    const back = liveRotationId(readDeskSession(TOKEN, join(home, ".claude", "peers")), currentId, adoptedSinceSpawn);
    if (back && transcriptExists(home, CWD, back)) return back;
    return null;
  }

  function seedTranscript(home: string, id: string): void {
    const dir = join(home, ".claude", "projects", encodeProjectDir(CWD));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), "{}\n", "utf-8");
  }

  test("adopts the post-/clear id when its transcript exists and differs", async () => {
    const home = tmpHome();
    const preClear = "26bbec1f-pre";
    const postClear = "0f79f2b1-post";
    await writeDeskSessionFile(TOKEN, { sid: postClear, source: "clear" }, home); // hook wrote the new id
    seedTranscript(home, postClear); // the post-/clear transcript exists
    expect(wouldAdopt(home, preClear)).toBe(postClear);
  });

  test("ignores a child claude's register write even when its transcript sits in the tile's cwd", async () => {
    const home = tmpHome();
    await writeDeskSessionFile(TOKEN, { sid: "child-probe", source: "register" }, home);
    seedTranscript(home, "child-probe");
    expect(wouldAdopt(home, "tile-id")).toBeNull();
  });

  test("adopts the tile's own late register write when no real id was adopted since spawn", async () => {
    const home = tmpHome();
    await writeDeskSessionFile(TOKEN, { sid: "slow-mcp-tile", source: "register" }, home);
    seedTranscript(home, "slow-mcp-tile");
    expect(wouldAdopt(home, "placeholder-id", false)).toBe("slow-mcp-tile");
  });

  test("no-op when the back-channel id equals the current id", async () => {
    const home = tmpHome();
    const id = "same-id";
    await writeDeskSessionFile(TOKEN, { sid: id, source: "clear" }, home);
    seedTranscript(home, id);
    expect(wouldAdopt(home, id)).toBeNull();
  });

  test("no-op when the back-channel id has no transcript (not resumable)", async () => {
    const home = tmpHome();
    await writeDeskSessionFile(TOKEN, { sid: "ghost-id", source: "clear" }, home); // no transcript seeded
    expect(wouldAdopt(home, "current-id")).toBeNull();
  });

  test("no-op when there is no back-channel file at all", () => {
    const home = tmpHome();
    expect(wouldAdopt(home, "current-id")).toBeNull();
  });
});
