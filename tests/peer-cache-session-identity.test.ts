import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readSessionIdentityFile,
  sessionIdentityFileName,
  writeSessionIdentityFile,
} from "../shared/peer-cache";

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

  test("round-trips a written (peerId, groupId) pair", async () => {
    await writeSessionIdentityFile("tile-token-1", "peer-a", "group-a", tmpHome);
    const read = await readSessionIdentityFile("tile-token-1", tmpHome);
    expect(read).toEqual({ peerId: "peer-a", groupId: "group-a" });
  });

  test("no file at all resolves to null", async () => {
    expect(await readSessionIdentityFile("no-such-token", tmpHome)).toBeNull();
  });

  const malformed: Array<[string, unknown]> = [
    ["peer_id empty string", { peer_id: "", group_id: "g" }],
    ["group_id empty string", { peer_id: "p", group_id: "" }],
    ["peer_id an array", { peer_id: ["p"], group_id: "g" }],
    ["peer_id a number", { peer_id: 123, group_id: "g" }],
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

  test("writer refuses to produce a file when groupId is empty (reader would reject it anyway)", async () => {
    await writeSessionIdentityFile("tile-token-2", "peer-b", "", tmpHome);
    expect(await readSessionIdentityFile("tile-token-2", tmpHome)).toBeNull();
  });

  test("writer refuses to produce a file when peerId is empty", async () => {
    await writeSessionIdentityFile("tile-token-3", "", "group-b", tmpHome);
    expect(await readSessionIdentityFile("tile-token-3", tmpHome)).toBeNull();
  });
});
