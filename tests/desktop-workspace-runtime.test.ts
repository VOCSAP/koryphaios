import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fromWorkspaceSessions,
  joinArgs,
  splitArgs,
  toWorkspaceSessions,
} from "../desktop/src/main/workspace-session-map.ts";
import { OpenIdRegistry } from "../desktop/src/main/open-id-registry.ts";
import {
  encodeProjectDir,
  transcriptExists,
  transcriptPath,
} from "../desktop/src/main/session-transcript.ts";
import type { WorkspaceSession } from "../desktop/src/main/workspace-store.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-home-"));
  tmpDirs.push(d);
  return d;
}

// ----- workspace-session-map -----

test("splitArgs/joinArgs round-trip incl. empty", () => {
  expect(splitArgs("")).toEqual([]);
  expect(splitArgs("   ")).toEqual([]);
  expect(joinArgs([])).toBe("");
  expect(splitArgs("--agent reviewer --model opus")).toEqual([
    "--agent",
    "reviewer",
    "--model",
    "opus",
  ]);
  expect(joinArgs(["--agent", "reviewer"])).toBe("--agent reviewer");
});

test("fromWorkspaceSessions(toWorkspaceSessions(defs)) preserves the durable fields", () => {
  const defs = [
    {
      id: "local-1",
      name: "reviewer",
      cwd: "/abs/project",
      command: "",
      args: "--agent reviewer",
      sessionId: "sid-1",
      color: "#4488ff",
      createdAt: 111,
    },
    {
      id: "local-2",
      name: "plain",
      cwd: "/abs/project",
      command: "",
      args: "",
      sessionId: "sid-2",
      color: "#3ec46d",
      createdAt: 222,
    },
  ];
  const round = fromWorkspaceSessions(toWorkspaceSessions(defs));
  expect(round.map((d) => d.name)).toEqual(["reviewer", "plain"]);
  expect(round.map((d) => d.cwd)).toEqual(["/abs/project", "/abs/project"]);
  expect(round.map((d) => d.color)).toEqual(["#4488ff", "#3ec46d"]);
  expect(round.map((d) => d.sessionId)).toEqual(["sid-1", "sid-2"]);
  expect(round.map((d) => d.args)).toEqual(["--agent reviewer", ""]);
  // Fresh local ids are minted (not carried over from the source defs).
  expect(round[0]!.id).not.toBe("local-1");
});

// A workspace rebuilds `command` as '' for every session, so the bridge marker
// is the ONLY thing that survives to tell a restored tile to relaunch through
// the wrapper. Losing it gives back a plain claude tile still carrying
// `--model "clodex:..."` in its args, which plain claude rejects.
test("the clodex bridge marker survives toWorkspaceSessions -> fromWorkspaceSessions, alongside the emptied command", () => {
  const defs = [
    {
      id: "local-1",
      name: "bridged",
      cwd: "/abs/project",
      command: "",
      bridge: "clodex" as const,
      args: '--model "clodex:openai-oauth:gpt-5.6-sol"',
      sessionId: "sid-1",
      color: "#4488ff",
      createdAt: 111,
    },
    {
      id: "local-2",
      name: "plain",
      cwd: "/abs/project",
      command: "",
      args: "",
      sessionId: "sid-2",
      color: "#3ec46d",
      createdAt: 222,
    },
  ];
  const persisted = toWorkspaceSessions(defs);
  expect(persisted.map((s) => s.bridge)).toEqual(["clodex", undefined]);
  const round = fromWorkspaceSessions(persisted);
  expect(round.map((d) => d.bridge)).toEqual(["clodex", undefined]);
  expect(round.map((d) => d.command)).toEqual(["", ""]);
});

// The workspace file is repo-cloned (hostile input): its `bridge` names the
// launch binary, so anything but the exact string must be dropped rather than
// carried into a spawn.
test("a bridge value that is not the exact 'clodex' string is dropped on restore, never carried into the def", () => {
  const hostile: WorkspaceSession[] = [
    "clodex-evil",
    "Clodex",
    "clodex ",
    "",
    1 as unknown as string,
    { toString: () => "clodex" } as unknown as string,
  ].map((bridge, i) => ({
    claudeSessionId: `sid-${i}`,
    name: `s-${i}`,
    cwd: "/p",
    args: [],
    bridge: bridge as WorkspaceSession["bridge"],
    color: "#000",
    position: i,
  }));
  expect(fromWorkspaceSessions(hostile).map((d) => d.bridge)).toEqual(hostile.map(() => undefined));
});

test("fromWorkspaceSessions honours position ordering", () => {
  const sessions: WorkspaceSession[] = [
    { claudeSessionId: "b", name: "B", cwd: "/p", args: [], color: "#000", position: 1 },
    { claudeSessionId: "a", name: "A", cwd: "/p", args: [], color: "#000", position: 0 },
  ];
  expect(fromWorkspaceSessions(sessions).map((d) => d.name)).toEqual(["A", "B"]);
});

// ----- open-id-registry -----

test("OpenIdRegistry blocks a second add of the same id until released", () => {
  const reg = new OpenIdRegistry();
  expect(reg.add("sid-1")).toBe(true);
  expect(reg.add("sid-1")).toBe(false); // already open
  expect(reg.has("sid-1")).toBe(true);
  expect(reg.size).toBe(1);
  reg.release("sid-1");
  expect(reg.has("sid-1")).toBe(false);
  expect(reg.add("sid-1")).toBe(true); // reusable after release
});

// ----- session-transcript -----

test("encodeProjectDir matches Claude's projects folder naming", () => {
  expect(encodeProjectDir("D:\\AI\\MCPServer\\claude-peers-mcp")).toBe(
    "D--AI-MCPServer-claude-peers-mcp",
  );
  // Existing hyphens preserved; stable across calls.
  expect(encodeProjectDir("/home/user/claude-peers-mcp")).toBe(
    "-home-user-claude-peers-mcp",
  );
  const once = encodeProjectDir("/a/b-c");
  expect(encodeProjectDir(once)).toBe(once.replace(/[^A-Za-z0-9]/g, "-"));
});

test("transcriptExists is true only when the id.jsonl is present", () => {
  const home = freshHome();
  const cwd = "/abs/project";
  const id = "sid-xyz";
  expect(transcriptExists(home, cwd, id)).toBe(false); // nothing yet
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
  expect(transcriptExists(home, cwd, id)).toBe(true);
  expect(transcriptExists(home, cwd, "other")).toBe(false);
  expect(transcriptExists(home, cwd, "")).toBe(false); // empty id never resolves
});

test("transcriptPath composes the encoded project dir", () => {
  const p = transcriptPath("/HOME", "/abs/proj", "sid-1");
  expect(p).toBe(join("/HOME", ".claude", "projects", "-abs-proj", "sid-1.jsonl"));
});
