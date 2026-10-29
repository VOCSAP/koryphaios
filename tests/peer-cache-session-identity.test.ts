import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { symlinkSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteSessionIdentityFile,
  globalSessionIdentityFileName,
  readGlobalSessionIdentityFile,
  readSessionIdentityFile,
  sessionIdentityFileName,
  tileIdentityGuard,
  writeGlobalSessionIdentityFile,
  writeSessionIdentityFile,
  type WriterGeneration,
} from "../shared/peer-cache";
import { measureWriterGeneration } from "../shared/process-generation.ts";

/** Scans EVERY file left in `dir`, not just the expected path: a deletion
 * mutated into a `rename` to a neighboring name would still pass a
 * single-path `access().rejects` check while the secret survives on disk
 * under a different filename. */
async function assertSecretNotOnDisk(dir: string, secret: string): Promise<void> {
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    const content = await readFile(join(dir, f), "utf-8").catch(() => "");
    expect(content).not.toContain(secret);
  }
}

describe("session-identity file", () => {
  let tmpHome: string;
  let peersDir: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "cp-identity-"));
    peersDir = join(tmpHome, ".claude", "peers");
    await mkdir(peersDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("derives a global identity filename from the messaging socket without exposing it", () => {
    const socket = "socket://private-rendezvous";
    const fileName = globalSessionIdentityFileName(socket);
    expect(fileName).toMatch(/^global-session-identity-[a-f0-9]{64}\.json$/);
    expect(fileName).not.toContain(socket);
  });

  test("round-trips a global identity keyed by the messaging socket", async () => {
    await writeGlobalSessionIdentityFile(
      "socket://private-rendezvous",
      "peer-global",
      "group-global",
      "instance-global",
      "project-global",
      tmpHome,
      null,
      "http://127.0.0.1:7899/",
    );
    expect(await readGlobalSessionIdentityFile("socket://private-rendezvous", tmpHome)).toMatchObject({
      peerId: "peer-global",
      groupId: "group-global",
      instanceToken: "instance-global",
      projectKey: "project-global",
      brokerUrl: "http://127.0.0.1:7899/",
    });
  });

  test("a global identity without a broker url is not published", async () => {
    await writeGlobalSessionIdentityFile("socket://private-rendezvous", "peer-global", "group-global", "instance-global", "project-global", tmpHome);
    expect(await readGlobalSessionIdentityFile("socket://private-rendezvous", tmpHome)).toBeNull();
  });

  test("round-trips a written (peerId, groupId, instanceToken) triple", async () => {
    await writeSessionIdentityFile("tile-token-1", "peer-a", "group-a", "token-a", tmpHome);
    const read = await readSessionIdentityFile("tile-token-1", tmpHome);
    expect(read).toEqual({
      peerId: "peer-a",
      groupId: "group-a",
      instanceToken: "token-a",
      inboxBinding: null,
      operatorId: null,
    });
  });

  test("round-trips an Inbox binding confirmation with its operator", async () => {
    await writeSessionIdentityFile(
      "tile-token-confirmed",
      "peer-confirmed",
      "group-confirmed",
      "instance-confirmed",
      tmpHome,
      { version: 1, runRef: "run-confirmed", groupId: "group-confirmed" },
      "operator-confirmed",
    );

    expect(await readSessionIdentityFile("tile-token-confirmed", tmpHome)).toEqual({
      peerId: "peer-confirmed",
      groupId: "group-confirmed",
      instanceToken: "instance-confirmed",
      inboxBinding: { version: 1, runRef: "run-confirmed", groupId: "group-confirmed" },
      operatorId: "operator-confirmed",
    });
  });

  test("round-trips a valid writer generation", async () => {
    const token = "writer-generation";
    await writeFile(
      join(peersDir, sessionIdentityFileName(token)),
      JSON.stringify({
        peer_id: "peer-generation",
        group_id: "group-generation",
        instance_token: "instance-generation",
        writer_generation: { platform: "win32", pid: 123, creation_utc: "2026-10-28T12:00:00.000Z" },
      }),
      "utf-8",
    );

    expect(await readSessionIdentityFile(token, tmpHome)).toEqual({
      peerId: "peer-generation",
      groupId: "group-generation",
      instanceToken: "instance-generation",
      inboxBinding: null,
      operatorId: null,
      writerGeneration: { platform: "win32", pid: 123, creationUtc: "2026-10-28T12:00:00.000Z" },
    });
  });

  const GEN_SOCKET = "socket://writer-generation";
  const GEN_BROKER = "http://127.0.0.1:7899/";

  async function writeGlobalWithGeneration(generation: WriterGeneration): Promise<void> {
    await writeGlobalSessionIdentityFile(
      GEN_SOCKET, "peer-gen", "group-gen", "instance-gen", "project-gen", tmpHome, generation, GEN_BROKER,
    );
  }

  test("writer persists the supplied writer generation", async () => {
    const generation: WriterGeneration = { platform: "win32", pid: 123, creationUtc: "2026-10-28T12:00:00.000Z" };
    await writeGlobalWithGeneration(generation);

    expect(await readGlobalSessionIdentityFile(GEN_SOCKET, tmpHome)).toMatchObject({ writerGeneration: generation });
  });

  test("reader refuses a snapshot when the writer process generation changed", async () => {
    await writeGlobalWithGeneration({ platform: "win32", pid: 123, creationUtc: "2026-10-28T12:00:00.000Z" });

    const identity = await readGlobalSessionIdentityFile(GEN_SOCKET, tmpHome, {
      measureWriterGeneration: async () => ({
        platform: "win32" as const,
        pid: 123,
        creationUtc: "2026-10-28T12:01:00.000Z",
      }),
    });
    expect(identity).toBeNull();
  });

  test("reader hands the pid recorded in the file to the injected measure function", async () => {
    const generation: WriterGeneration = { platform: "win32", pid: 4321, creationUtc: "2026-10-28T12:00:00.000Z" };
    await writeGlobalWithGeneration(generation);

    const seen: number[] = [];
    const identity = await readGlobalSessionIdentityFile(GEN_SOCKET, tmpHome, {
      verifyWriterGeneration: true,
      measureWriterGeneration: async (pid) => {
        seen.push(pid);
        return generation;
      },
    });
    expect(seen).toEqual([4321]);
    expect(identity).toMatchObject({ writerGeneration: generation });
  });

  test("reader refuses when verification is requested but no measure function is supplied", async () => {
    await writeGlobalWithGeneration({ platform: "win32", pid: 4321, creationUtc: "2026-10-28T12:00:00.000Z" });

    expect(await readGlobalSessionIdentityFile(GEN_SOCKET, tmpHome, { verifyWriterGeneration: true })).toBeNull();
    expect(await readGlobalSessionIdentityFile(GEN_SOCKET, tmpHome)).not.toBeNull();
  });

  test("reader verification rejects a live process whose recorded generation is stale", async () => {
    await writeGlobalWithGeneration({ platform: "win32", pid: process.pid, creationUtc: "2000-01-01T00:00:00.000Z" });

    expect(
      await readGlobalSessionIdentityFile(GEN_SOCKET, tmpHome, { verifyWriterGeneration: true, measureWriterGeneration }),
    ).toBeNull();
  });

  test("a platform without a process generation measurement yields none", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    const measuredHere = await measureWriterGeneration(process.pid);
    try {
      Object.defineProperty(process, "platform", { ...original, value: "darwin" });
      expect(await measureWriterGeneration(process.pid), "darwin must measure no generation, so no snapshot is ever published").toBeNull();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    if (process.platform !== "darwin") {
      expect(measuredHere, "control: the real platform measures the current process").not.toBeNull();
    }
  });

  test.skipIf(process.platform === "darwin")("reader verification accepts the live writer process generation (needs a measurable process generation, refused on darwin)", async () => {
    const writerGeneration = await measureWriterGeneration(process.pid);
    expect(writerGeneration).not.toBeNull();
    if (!writerGeneration) throw new Error("current process generation was not measurable");

    await writeGlobalWithGeneration(writerGeneration);

    expect(
      await readGlobalSessionIdentityFile(GEN_SOCKET, tmpHome, { verifyWriterGeneration: true, measureWriterGeneration }),
    ).toMatchObject({ writerGeneration });
  });

  test("a confirmation cannot be persisted without its operator", async () => {
    await expect(
      writeSessionIdentityFile(
        "tile-token-partial",
        "peer-partial",
        "group-partial",
        "instance-partial",
        tmpHome,
        { version: 1, runRef: "run-partial", groupId: "group-partial" },
      ),
    ).rejects.toThrow("Inbox binding confirmation and operator must be written together");
  });

  test("a malformed Inbox confirmation stays non-ready while preserving resume identity", async () => {
    await writeFile(
      join(peersDir, sessionIdentityFileName("v2")),
      JSON.stringify({
        peer_id: "peer-v2",
        group_id: "group-v2",
        instance_token: "instance-v2",
        inbox_binding: { version: 2, run_ref: "run-v2", group_id: "group-v2" },
        operator_id: "operator-v2",
      }),
      "utf-8",
    );
    await writeFile(
      join(peersDir, sessionIdentityFileName("partial")),
      JSON.stringify({
        peer_id: "peer-partial",
        group_id: "group-partial",
        instance_token: "instance-partial",
        inbox_binding: { version: 1, run_ref: "run-partial", group_id: "group-partial" },
      }),
      "utf-8",
    );

    for (const sessionId of ["v2", "partial"]) {
      const identity = await readSessionIdentityFile(sessionId, tmpHome);
      expect(identity?.inboxBinding).toBeNull();
      expect(identity?.operatorId).toBeNull();
      expect(identity?.instanceToken).toContain("instance");
    }
  });

  test("writer surfaces an atomic write failure", async () => {
    const sessionId = "write-failure";
    await mkdir(join(peersDir, `${sessionIdentityFileName(sessionId)}.${process.pid}.tmp`));
    await expect(writeSessionIdentityFile(sessionId, "peer", "group", "instance", tmpHome)).rejects.toThrow();
  });

  test("a failed atomic rename removes the temporary identity snapshot", async () => {
    const sessionId = "rename-failure";
    const filename = sessionIdentityFileName(sessionId);
    await mkdir(join(peersDir, filename));

    await expect(writeSessionIdentityFile(sessionId, "peer", "group", "instance", tmpHome)).rejects.toThrow();
    expect(await readdir(peersDir)).not.toContain(`${filename}.${process.pid}.tmp`);
  });

  test("no file at all resolves to null", async () => {
    expect(await readSessionIdentityFile("no-such-token", tmpHome)).toBeNull();
  });

  const malformed: Array<[string, unknown]> = [
    ["peer_id empty string", { peer_id: "", group_id: "g", instance_token: "t" }],
    ["group_id empty string", { peer_id: "p", group_id: "", instance_token: "t" }],
    ["instance_token empty string", { peer_id: "p", group_id: "g", instance_token: "" }],
    ["instance_token missing entirely", { peer_id: "p", group_id: "g" }],
    ["peer_id an array", { peer_id: ["p"], group_id: "g", instance_token: "t" }],
    ["peer_id a number", { peer_id: 123, group_id: "g", instance_token: "t" }],
    ["writer generation has an unknown platform", { peer_id: "p", group_id: "g", instance_token: "t", writer_generation: { platform: "other", pid: 1 } }],
    ["writer generation has no process id", { peer_id: "p", group_id: "g", instance_token: "t", writer_generation: { platform: "win32", creation_utc: "2026-10-28T12:00:00.000Z" } }],
    ["file content a bare JSON string", "just-a-string"],
    ["file content a JSON null", null],
  ];

  for (const [label, content] of malformed) {
    test(`rejects as null: ${label}`, async () => {
      const token = `malformed-${label.replace(/\s+/g, "-")}`;
      await writeFile(join(peersDir, sessionIdentityFileName(token)), JSON.stringify(content), "utf-8");
      expect(await readSessionIdentityFile(token, tmpHome)).toBeNull();
    });
  }

  // Checked by file EXISTENCE, not by readSessionIdentityFile: the reader has
  // its own (separate) rejection of an empty field, so a round-trip-only
  // assertion here would stay green even if the WRITER's guard were deleted
  // -- proven by mutation (removing `|| !groupId` etc. from the writer left
  // this shape of assertion green, masked by the reader's own guard).
  test("writer refuses to produce a file when groupId is empty (reader would reject it anyway)", async () => {
    await writeSessionIdentityFile("tile-token-2", "peer-b", "", "token-b", tmpHome);
    await expect(access(join(peersDir, sessionIdentityFileName("tile-token-2")))).rejects.toThrow();
  });

  test("writer refuses to produce a file when peerId is empty", async () => {
    await writeSessionIdentityFile("tile-token-3", "", "group-b", "token-b", tmpHome);
    await expect(access(join(peersDir, sessionIdentityFileName("tile-token-3")))).rejects.toThrow();
  });

  test("writer refuses to produce a file when instanceToken is empty", async () => {
    await writeSessionIdentityFile("tile-token-4", "peer-c", "group-c", "", tmpHome);
    await expect(access(join(peersDir, sessionIdentityFileName("tile-token-4")))).rejects.toThrow();
  });

  // NTFS has no POSIX permission bits: mode passed to writeFile is a no-op on
  // Windows (measured -- st.mode reads 0o666 regardless of the 0o600 asked
  // for), so this only proves anything on a real POSIX filesystem.
  test.skipIf(process.platform === "win32")(
    "the file is written 0600, never world- or group-readable",
    async () => {
      await writeSessionIdentityFile("tile-token-5", "peer-d", "group-d", "token-d", tmpHome);
      const { stat } = await import("node:fs/promises");
      const st = await stat(join(peersDir, sessionIdentityFileName("tile-token-5")));
      expect(st.mode & 0o777).toBe(0o600);
    }
  );

  // A `rename` to a neighboring name would satisfy an access() check at the
  // expected path alone while leaving the secret in plaintext elsewhere in
  // the dir -- proven by mutation, the directory-wide scan is what catches it.
  test("deleteSessionIdentityFile removes a written file (and leaves no copy of the secret anywhere in the dir)", async () => {
    await writeSessionIdentityFile("tile-token-6", "peer-e", "group-e", "token-e", tmpHome);
    expect(await readSessionIdentityFile("tile-token-6", tmpHome)).not.toBeNull();
    await deleteSessionIdentityFile("tile-token-6", tmpHome);
    await expect(access(join(peersDir, sessionIdentityFileName("tile-token-6")))).rejects.toThrow();
    await assertSecretNotOnDisk(peersDir, "token-e");
  });

  test("deleteSessionIdentityFile propagates a non-ENOENT failure instead of swallowing it silently", async () => {
    const target = join(peersDir, sessionIdentityFileName("tile-token-8"));
    await writeSessionIdentityFile("tile-token-8", "peer-g", "group-g", "token-g", tmpHome);
    // A directory in place of the file makes unlink fail with EISDIR/EPERM,
    // not ENOENT -- the shape of failure deleteSessionIdentityFile must not
    // swallow.
    await rm(target, { force: true });
    await mkdir(target);
    await expect(deleteSessionIdentityFile("tile-token-8", tmpHome)).rejects.toThrow();
  });

  test("deleteSessionIdentityFile on an absent file is a silent no-op", async () => {
    await expect(deleteSessionIdentityFile("never-written", tmpHome)).resolves.toBeUndefined();
  });

  test("writeSessionIdentityFile never writes the instance_token in plaintext anywhere but the JSON value field (sanity: field name only, not leaked into another key)", async () => {
    await writeSessionIdentityFile("tile-token-7", "peer-f", "group-f", "super-secret-token", tmpHome);
    const raw = await readFile(join(peersDir, sessionIdentityFileName("tile-token-7")), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["group_id", "instance_token", "peer_id"]);
  });
});

describe("tileIdentityGuard", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cp-tile-guard-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const tileEnv = (tileCwd?: string): Record<string, string | undefined> => ({
    CLAUDE_PEERS_DESK_SESSION: "tile-guard-token",
    CLAUDE_PEERS_DESK_TILE_CWD: tileCwd,
  });

  test("a process whose cwd is not the tile cwd is refused, naming both directories", async () => {
    const tile = join(root, "tile");
    const child = join(root, "cp-register-test");
    await mkdir(tile);
    await mkdir(child);
    const verdict = tileIdentityGuard(tileEnv(tile), child);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain(child);
      expect(verdict.reason).toContain(tile);
    }
  });

  test("a process at the tile cwd is allowed", async () => {
    const tile = join(root, "tile");
    await mkdir(tile);
    expect(tileIdentityGuard(tileEnv(tile), tile)).toEqual({ allowed: true });
  });

  test("a worktree tile is allowed at its worktree and refused at the main checkout", async () => {
    const main = join(root, "repo");
    const worktree = join(main, ".worktrees", "fix");
    await mkdir(worktree, { recursive: true });
    expect(tileIdentityGuard(tileEnv(worktree), worktree)).toEqual({ allowed: true });
    expect(tileIdentityGuard(tileEnv(worktree), main).allowed).toBe(false);
  });

  test("a tile cwd reached through a symlinked or junctioned prefix equals the real cwd", async () => {
    const real = join(root, "real");
    await mkdir(join(real, "project"), { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link, "junction");
    expect(tileIdentityGuard(tileEnv(join(link, "project")), join(real, "project"))).toEqual({ allowed: true });
    expect(tileIdentityGuard(tileEnv(join(real, "project")), join(link, "project"))).toEqual({ allowed: true });
  });

  test("without a desk session the guard has nothing to protect and allows", async () => {
    expect(tileIdentityGuard({ CLAUDE_PEERS_DESK_TILE_CWD: join(root, "elsewhere") }, root)).toEqual({ allowed: true });
  });

  test("a Deck that exports no tile cwd keeps the pre-guard behaviour", async () => {
    expect(tileIdentityGuard(tileEnv(undefined), root)).toEqual({ allowed: true });
    expect(tileIdentityGuard(tileEnv("   "), root)).toEqual({ allowed: true });
  });
});
