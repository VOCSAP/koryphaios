// Card 3d121a74 lot L3-a: the ONE-SHOT peer_sessions purge that pays for the
// widened identity key.
//
// Why a purge at all, and why it cannot be a migration: peer_sessions holds
// six columns (session_key, instance_token, group_id, host, cwd,
// last_active_at) and NONE identifies a tile or a CC session, so there is
// nothing to recompute a widened key from. Coexistence (try the new key, fall
// back to the old) was refused by design and IS the mechanism of the bug: the
// legacy key hands a tile ANOTHER tile's row, hence its instance_token, hence
// its undelivered mail.
//
// The database under test is not hand-rolled: a real broker writes a real
// database, which is then DOWNGRADED by dropping the new column, so the
// migration runs against rows a genuine pre-L3-a broker produced.

import { test, expect, afterAll } from "bun:test";
import { readdirSync, readFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

const brokers: TestBroker[] = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const b of brokers) await stopBroker(b);
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function readLogs(tmpDir: string): string {
  const dir = join(tmpDir, "logs");
  let out = "";
  for (const f of readdirSync(dir)) {
    out += readFileSync(join(dir, f), "utf-8");
  }
  return out;
}

/**
 * Stop a broker and hand back a COPY of its database, outside the sandbox
 * stopBroker deletes. Two traps this closes, both paid for once here: the
 * helper's cleanup rm -rf's the whole temp dir (so reusing `b.dbPath` after
 * stopBroker gives SQLITE_CANTOPEN), and broker.ts runs in WAL mode, so the
 * committed rows may still live in `-wal` -- the sidecars are copied too,
 * rather than assuming a checkpoint happened.
 */
async function detachDb(b: TestBroker): Promise<string> {
  try {
    b.proc.kill();
    await b.proc.exited;
  } catch { /* already gone */ }
  const dir = mkdtempSync(join(tmpdir(), "cp-mig-"));
  tmpDirs.push(dir);
  const target = join(dir, "peers.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${b.dbPath}${suffix}`;
    if (existsSync(src)) copyFileSync(src, `${target}${suffix}`);
  }
  return target;
}

test(
  "the one-shot purge drops peer_sessions, never peers, and logs BOTH numbers",
  async () => {
    // 1) A pre-L3-a broker's data, produced by a real broker.
    const first = await startBroker();
    brokers.push(first);
    const reg = async (host: string, cwd: string) =>
      post<{ peer_id: string; instance_token: string }>(`${first.url}/register`, {
        pid: livePid(), cwd, git_root: null, tty: null, summary: "", host,
        client_pid: 1, project_key: null, group_id: "default", group_secret_hash: null,
      });
    const a = await reg("hostMig", "/mig-a");
    const b = await reg("hostMig", "/mig-b");
    // Undelivered mail addressed to a's TOKEN -- the victim of the rotation.
    for (const text of ["m1", "m2"]) {
      const sent = await post<{ ok: boolean; error?: string }>(`${first.url}/send-message`, {
        from_token: b.body.instance_token,
        to_peer_id: a.body.peer_id,
        text,
      });
      // Assert the SETUP, never assume it: a silently refused send would make
      // the undelivered count 0 and turn the log assertion below into a test
      // of nothing (measured once here -- a wrong field name did exactly that).
      expect(sent.body.ok).toBe(true);
    }
    const dbPath = await detachDb(first);
    {
      const db = new Database(dbPath);
      const sessionsBefore = (db.query("SELECT COUNT(*) AS n FROM peer_sessions").get() as { n: number }).n;
      const undeliveredBefore = (db.query("SELECT COUNT(*) AS n FROM messages WHERE delivered = 0").get() as { n: number }).n;
      expect(sessionsBefore).toBe(2);
      expect(undeliveredBefore).toBeGreaterThanOrEqual(1);
      // 2) Downgrade to the pre-L3-a shape so the migration has work to do.
      db.run("ALTER TABLE peer_sessions DROP COLUMN cc_session_id");
      db.close();
    }

    // 3) Boot a broker on that legacy database: the ALTER succeeds exactly
    //    once, and that success is what arms the purge.
    const second = await startBroker({ CLAUDE_PEERS_DB: dbPath });
    brokers.push(second);

    const db = new Database(dbPath, { readonly: true });
    const sessionsAfter = (db.query("SELECT COUNT(*) AS n FROM peer_sessions").get() as { n: number }).n;
    const peersAfter = (db.query("SELECT COUNT(*) AS n FROM peers WHERE cwd <> ''").get() as { n: number }).n;
    const stillThere = db.query("SELECT instance_token FROM peers WHERE instance_token = ?")
      .get(a.body.instance_token) as { instance_token: string } | null;
    const messagesAfter = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    db.close();

    expect(sessionsAfter).toBe(0);        // identity memory dropped: no resurrection possible
    expect(peersAfter).toBe(2);           // peers NEVER purged
    expect(stillThere).not.toBeNull();    // tokens kept, they age out via the dormant TTL
    expect(messagesAfter).toBeGreaterThanOrEqual(1); // mail untouched -- and now orphaned

    // 4) ONE line, TWO numbers. The undelivered count is the one nobody thinks
    //    to take: `messages` is keyed by to_token, so the purge orphans that
    //    mail rather than deleting it, and the loss must never be silent.
    const logs = readLogs(second.tmpDir);
    const line = logs.split("\n").find((l) => l.includes("migration 3d121a74")) ?? "";
    expect(line).toContain("2 session row(s) dropped");
    expect(line).toMatch(/\d+ undelivered message\(s\) now unreachable/);
  },
  20_000
);

test(
  "the purge is idempotent: a SECOND boot on the migrated database purges nothing",
  async () => {
    const first = await startBroker();
    brokers.push(first);
    await post(`${first.url}/register`, {
      pid: livePid(), cwd: "/idem", git_root: null, tty: null, summary: "",
      host: "hostIdem", client_pid: 1, project_key: null,
      group_id: "default", group_secret_hash: null,
    });
    const dbPath = await detachDb(first);

    // No downgrade this time: the column already exists, so the ALTER throws
    // duplicate-column and the purge must NOT run -- otherwise every restart
    // would rotate everyone's identity.
    const second = await startBroker({ CLAUDE_PEERS_DB: dbPath });
    brokers.push(second);

    const db = new Database(dbPath, { readonly: true });
    const sessions = (db.query("SELECT COUNT(*) AS n FROM peer_sessions").get() as { n: number }).n;
    db.close();
    expect(sessions).toBe(1);
    expect(readLogs(second.tmpDir)).not.toContain("migration 3d121a74");
  },
  20_000
);
