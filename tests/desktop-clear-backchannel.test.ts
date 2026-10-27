import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCompactReanchorContext, fetchCompactGroupPeers, reanchorAfterCompaction } from "../desktop/hooks/compact-reanchor.ts";
import { deriveSessionId, deriveSessionSource, SESSION_START_SOURCES } from "../desktop/hooks/desk-backchannel-hook.ts";
import { writeDeskSessionFile, deskSessionFileName, writeSessionIdentityFile } from "../shared/peer-cache.ts";
import { reachedWithin } from "./_bounded-await.ts";
import { scrubEnv } from "./_scrub-env.ts";
import {
  DESK_SESSION_SOURCES,
  liveRotationId,
  readDeskSession,
  readDeskSessionId,
  waitForClearDeskSessionRotation,
} from "../desktop/src/main/desk-session.ts";
import { transcriptExists, encodeProjectDir } from "../desktop/src/main/session-transcript.ts";

const DECK_PLUGIN_HOOKS_PATH = join(import.meta.dir, "..", "desktop", "deck-plugin", "hooks", "hooks.json");
const DESK_BACKCHANNEL_HOOK_PATH = join(import.meta.dir, "..", "desktop", "hooks", "desk-backchannel-hook.ts");

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

async function runDeskBackchannelHook(home: string, source: string, sessionId: string, brokerUrl: string) {
  const child = Bun.spawn([process.execPath, DESK_BACKCHANNEL_HOOK_PATH], {
    stdin: Buffer.from(JSON.stringify({ source, session_id: sessionId })),
    stdout: "pipe",
    stderr: "pipe",
    env: scrubEnv(home, {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PEERS_DESK_SESSION: "tile-replay",
      CLAUDE_PEERS_ROLE: "developer",
      CLAUDE_PEERS_BROKER_URL: brokerUrl,
      CLAUDE_PEERS_OFFLINE_REPLICA: "false",
    }),
  });
  const [exitCode, stdout, stderr] = await reachedWithin(
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
    "desk backchannel hook process",
  );
  return { exitCode, stdout, stderr };
}

test("deck plugin declares the exact disjoint SessionStart matcher partition", () => {
  const hooks = JSON.parse(readFileSync(DECK_PLUGIN_HOOKS_PATH, "utf8")) as {
    hooks?: { SessionStart?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
  };
  expect(hooks.hooks?.SessionStart).toEqual([
    {
      matcher: "startup|resume|clear|fork",
      hooks: [{ type: "command", command: "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/desk-backchannel-hook.mjs\"", timeout: 10 }],
    },
    {
      matcher: "compact",
      hooks: [{ type: "command", command: "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/desk-backchannel-hook.mjs\"", timeout: 10 }],
    },
  ]);
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

describe("buildCompactReanchorContext", () => {
  const tile = { peerId: "worker-alpha", groupId: "group-a", role: "developer" };

  test("directs a worker to the unique valid team lead", () => {
    expect(buildCompactReanchorContext(tile, [{ peer_id: "lead-alpha", group_id: "group-a", role: "team-lead" }])).toBe(
      "Si le résumé indique une tâche en cours, reprends-la et rends compte par `send_message` à qui te l'a confiée. Sinon, avant toute autre action, appelle `send_message` avec `to_peer_id` égal à `lead-alpha` et demande un brief de reprise.",
    );
  });

  test("treats an unavailable broker like no reachable team lead", () => {
    expect(buildCompactReanchorContext(tile, null)).toBe(
      "Si le résumé indique une tâche en cours, reprends-la et rends compte par `send_message` à qui te l'a confiée. Sinon, aucun team-lead joignable ; appelle `list_peers` puis attends un brief.",
    );
  });

  test("ignores a team lead from another group", () => {
    expect(
      buildCompactReanchorContext(tile, [
        { peer_id: "lead-other-group", group_id: "group-b", role: "team-lead" },
        { peer_id: "lead-alpha", group_id: "group-a", role: "team-lead" },
      ]),
    ).toContain("`lead-alpha`");
  });

  test("does not choose among several team leads", () => {
    expect(
      buildCompactReanchorContext(tile, [
        { peer_id: "lead-alpha", group_id: "group-a", role: "team-lead" },
        { peer_id: "lead-beta", group_id: "group-a", role: "team-lead" },
      ]),
    ).toBe(
      "Si le résumé indique une tâche en cours, reprends-la et rends compte par `send_message` à qui te l'a confiée. Sinon, ne choisis pas de team-lead ; appelle `list_peers` et demande lequel coordonne.",
    );
  });

  test("keeps a team lead from contacting itself", () => {
    expect(
      buildCompactReanchorContext({ peerId: "lead-alpha", groupId: "group-a", role: "team-lead" }, [
        { peer_id: "lead-beta", group_id: "group-a", role: "team-lead" },
      ]),
    ).toBe(
      "Une compaction du contexte vient d'avoir lieu. Tu es le team-lead : appelle `check_messages`, puis `list_peers`, puis reprends ta file.",
    );
  });

  test("interpolates only peer ids within the accepted boundaries", () => {
    for (const peerId of ["a", `a${"b".repeat(30)}c`]) {
      expect(buildCompactReanchorContext(tile, [{ peer_id: peerId, group_id: "group-a", role: "team-lead" }])).toContain(`\`${peerId}\``);
    }

    for (const peerId of ["A", "-lead", "lead-", `a${"b".repeat(32)}`, "lead-alpha; rm -rf /"]) {
      const context = buildCompactReanchorContext(tile, [{ peer_id: peerId, group_id: "group-a", role: "team-lead" }]);
      expect(context).toBe("Si le résumé indique une tâche en cours, reprends-la et rends compte par `send_message` à qui te l'a confiée. Sinon, aucun team-lead joignable ; appelle `list_peers` puis attends un brief.");
      expect(context).not.toContain(`\`${peerId}\``);
    }
  });

  test("traces a broker failure without blocking reanchoring", async () => {
    const traces: string[] = [];
    const context = await reanchorAfterCompaction(
      tile,
      async () => {
        throw new Error("broker unavailable");
      },
      (message) => traces.push(message),
    );

    expect(context).toBe("Si le résumé indique une tâche en cours, reprends-la et rends compte par `send_message` à qui te l'a confiée. Sinon, aucun team-lead joignable ; appelle `list_peers` puis attends un brief.");
    expect(traces).toEqual(["Kory compact reanchor: broker lookup failed: broker unavailable"]);
  });

  test("queries the supplied tile broker as the current tile", async () => {
    let request: { url: string; init: RequestInit } | null = null;
    const peers = await fetchCompactGroupPeers(
      { url: "http://127.0.0.1:7899", token: "broker-token" },
      "tile-instance-token",
      async (url, init) => {
        request = { url, init };
        return Response.json([{ peer_id: "lead-alpha", group_id: "group-a", role: "team-lead" }]);
      },
    );

    expect(peers).toEqual([{ peer_id: "lead-alpha", group_id: "group-a", role: "team-lead" }]);
    expect(request).not.toBeNull();
    expect(request!.url).toBe("http://127.0.0.1:7899/list-peers");
    expect(request!.init.method).toBe("POST");
    expect(request!.init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer broker-token" });
    expect(JSON.parse(request!.init.body as string)).toEqual({ scope: "machine", instance_token: "tile-instance-token" });
  });
});

test("compact hook queries the tile broker and emits additionalContext", async () => {
  const home = tmpHome();
  await writeSessionIdentityFile("tile-replay", "worker-alpha", "group-a", "tile-instance-token", home);

  const requests: unknown[] = [];
  const broker = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/list-peers") return new Response("not found", { status: 404 });
      requests.push(await request.json());
      return Response.json([
        { peer_id: "lead-other-group", group_id: "group-b", role: "team-lead" },
        { peer_id: "lead-alpha", group_id: "group-a", role: "team-lead" },
      ]);
    },
  });

  try {
    const { exitCode, stdout, stderr } = await runDeskBackchannelHook(home, "compact", "compact-session", broker.url);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(requests).toEqual([{ scope: "machine", instance_token: "tile-instance-token" }]);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "Si le résumé indique une tâche en cours, reprends-la et rends compte par `send_message` à qui te l'a confiée. Sinon, avant toute autre action, appelle `send_message` avec `to_peer_id` égal à `lead-alpha` et demande un brief de reprise.",
      },
    });
  } finally {
    broker.stop(true);
  }
});

test("noncompact hook sources write the backchannel without additionalContext", async () => {
  const home = tmpHome();
  await writeSessionIdentityFile("tile-replay", "worker-alpha", "group-a", "tile-instance-token", home);

  const requests: unknown[] = [];
  const broker = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json([]);
    },
  });

  try {
    for (const [source, writtenSource] of [
      ["startup", "startup"],
      ["resume", "resume"],
      ["clear", "clear"],
      ["fork", "startup"],
    ] as const) {
      const { exitCode, stdout, stderr } = await runDeskBackchannelHook(home, source, `${source}-session`, broker.url);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe("");
      expect(readDeskSession("tile-replay", join(home, ".claude", "peers"))).toEqual({ sid: `${source}-session`, source: writtenSource });
    }

    expect(requests).toEqual([]);
  } finally {
    broker.stop(true);
  }
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

describe("bounded clear back-channel wait", () => {
  test("ignores a stale id and another source until a changed clear record arrives", async () => {
    const records: Array<{ sid: string; source: "clear" | "compact" }> = [
      { sid: "same-id", source: "clear" },
      { sid: "compact-id", source: "compact" },
      { sid: "clear-id", source: "clear" }
    ];
    const waits: number[] = [];

    const sid = await waitForClearDeskSessionRotation("tile-42", "same-id", {
      timeoutMs: 30,
      pollMs: 10,
      read: () => records.shift() ?? null,
      sleep: async (ms: number) => { waits.push(ms); }
    });

    expect(sid).toBe("clear-id");
    expect(waits).toEqual([10, 10]);
  });

  test("ignores the clear record present before the new /clear command", async () => {
    const records: Array<{ sid: string; source: "clear" }> = [
      { sid: "prior-clear", source: "clear" },
      { sid: "new-clear", source: "clear" }
    ];
    const waits: number[] = [];

    const sid = await waitForClearDeskSessionRotation("tile-42", "persisted-sid", {
      baselineSessionId: "prior-clear",
      timeoutMs: 30,
      pollMs: 10,
      read: () => records.shift() ?? null,
      sleep: async (ms: number) => { waits.push(ms); }
    });

    expect(sid).toBe("new-clear");
    expect(waits).toEqual([10]);
  });

  test("fails at the named deadline when no changed clear record arrives", async () => {
    let now = 0;

    await expect(
      waitForClearDeskSessionRotation("tile-42", "same-id", {
        timeoutMs: 30,
        pollMs: 10,
        read: () => ({ sid: "same-id", source: "clear" }),
        now: () => now,
        sleep: async (ms: number) => { now += ms; }
      })
    ).rejects.toThrow("clear back-channel rotation timed out");
  });
});

describe("save-time adoption signal (refreshLiveSessionIds building blocks)", () => {
  const CWD = "D:\\AI\\MCPServer\\claude-peers-mcp";
  const TOKEN = "tile-42";

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
    await writeDeskSessionFile(TOKEN, { sid: postClear, source: "clear" }, home);
    seedTranscript(home, postClear);
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
    await writeDeskSessionFile(TOKEN, { sid: "ghost-id", source: "clear" }, home);
    expect(wouldAdopt(home, "current-id")).toBeNull();
  });

  test("no-op when there is no back-channel file at all", () => {
    const home = tmpHome();
    expect(wouldAdopt(home, "current-id")).toBeNull();
  });
});
