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

import { deriveSessionId } from "../desktop/hooks/desk-backchannel-hook.ts";
import { writeDeskSessionFile, deskSessionFileName } from "../shared/peer-cache.ts";
import { readDeskSessionId } from "../desktop/src/main/desk-session.ts";
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

describe("writeDeskSessionFile", () => {
  test("writes the id to desk-session-<token>.txt", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("tile-A", "id-123", home);
    const f = join(home, ".claude", "peers", deskSessionFileName("tile-A"));
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("id-123");
  });

  test("is a no-op when token is empty", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("", "id-123", home);
    expect(existsSync(join(home, ".claude", "peers"))).toBe(false);
  });

  test("is a no-op when id is empty/whitespace", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("tile-A", "   ", home);
    const f = join(home, ".claude", "peers", deskSessionFileName("tile-A"));
    expect(existsSync(f)).toBe(false);
  });

  test("round-trips through the Deck reader (readDeskSessionId)", async () => {
    const home = tmpHome();
    await writeDeskSessionFile("tile-X", "minted-42", home);
    expect(readDeskSessionId("tile-X", join(home, ".claude", "peers"))).toBe("minted-42");
  });
});

describe("save-time adoption signal (refreshLiveSessionIds building blocks)", () => {
  const CWD = "D:\\AI\\MCPServer\\claude-peers-mcp";
  const TOKEN = "tile-42";

  // Mirror of the refreshLiveSessionIds predicate, fed by the real readers, so
  // the test exercises the exact condition the service uses.
  function wouldAdopt(home: string, currentId: string): string | null {
    const back = readDeskSessionId(TOKEN, join(home, ".claude", "peers"));
    if (back && back !== currentId && transcriptExists(home, CWD, back)) return back;
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
    await writeDeskSessionFile(TOKEN, postClear, home); // hook wrote the new id
    seedTranscript(home, postClear); // the post-/clear transcript exists
    expect(wouldAdopt(home, preClear)).toBe(postClear);
  });

  test("no-op when the back-channel id equals the current id", async () => {
    const home = tmpHome();
    const id = "same-id";
    await writeDeskSessionFile(TOKEN, id, home);
    seedTranscript(home, id);
    expect(wouldAdopt(home, id)).toBeNull();
  });

  test("no-op when the back-channel id has no transcript (not resumable)", async () => {
    const home = tmpHome();
    await writeDeskSessionFile(TOKEN, "ghost-id", home); // no transcript seeded
    expect(wouldAdopt(home, "current-id")).toBeNull();
  });

  test("no-op when there is no back-channel file at all", () => {
    const home = tmpHome();
    expect(wouldAdopt(home, "current-id")).toBeNull();
  });
});
