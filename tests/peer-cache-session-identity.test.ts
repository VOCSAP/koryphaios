import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteSessionIdentityFile,
  readSessionIdentityFile,
  sessionIdentityFileName,
  writeSessionIdentityFile,
} from "../shared/peer-cache";

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

  test("round-trips a written (peerId, groupId, instanceToken) triple", async () => {
    await writeSessionIdentityFile("tile-token-1", "peer-a", "group-a", "token-a", tmpHome);
    const read = await readSessionIdentityFile("tile-token-1", tmpHome);
    expect(read).toEqual({ peerId: "peer-a", groupId: "group-a", instanceToken: "token-a" });
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
