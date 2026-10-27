// Exercise the filesystem side effect: inspecting the env object would not prove the spawned server consumes it.

import { test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { FIXTURE_OPERATOR_ID, groupId, mintRunCredential, sha256Hex, startBroker, stopBroker, scrubEnv, type TestBroker } from "./_helper.ts";
import { sessionIdentityFileName } from "../shared/peer-cache.ts";

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const b of brokers) await stopBroker(b);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("a server.ts spawned through scrubEnv writes its session-identity file under the scratch HOME, never under the real one", async () => {
  const b = await startBroker();
  brokers.push(b);
  const scratch = mkdtempSync(join(tmpdir(), "cp-scrubenv-home-"));
  dirs.push(scratch);
  const secret = crypto.randomUUID();
  mkdirSync(join(scratch, "claude-peers"), { recursive: true });
  writeFileSync(join(scratch, "claude-peers", "config.json"), JSON.stringify({ groups: { alpha: secret }, default_group: "alpha" }));
  const run = await mintRunCredential(b, { id: await groupId(secret), hash: await sha256Hex(secret) });
  const credFile = join(scratch, "run-credential.json");
  writeFileSync(
    credFile,
    JSON.stringify({
      brokerUrl: b.url,
      operatorId: FIXTURE_OPERATOR_ID,
      tokenId: run.tokenId,
      sessionRef: `window-${run.run}`,
      privateKey: run.cred.privateKey,
      publicKey: run.cred.publicKey,
      osUserHash: "hash",
      inbox: { version: 1, run_ref: run.run, group_id: run.group },
    }),
    { mode: 0o600 }
  );

  // Unique per run so this assertion can never collide with a real tile's
  // own token (CLAUDE_PEERS_DESK_SESSION is stable per tile, never this
  // shape) -- a false negative here would require a real desk session
  // literally named this probe string.
  const token = `scrubenv-home-probe-${process.pid}-${Date.now()}`;
  const scratchIdentityFile = join(scratch, ".claude", "peers", sessionIdentityFileName(token));
  const realIdentityFile = join(homedir(), ".claude", "peers", sessionIdentityFileName(token));

  // stdin stays open ("pipe", never .end()'d): "ignore" reads as immediate
  // EOF, which server.ts treats as "Claude Code closed" and races its own
  // cleanup()/delete against the register write this test is trying to catch.
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
    cwd: scratch,
    env: scrubEnv(scratch, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_DESK_SESSION: token,
      CLAUDE_PEERS_APPROVAL_FILE: credFile,
    }),
    stdio: ["pipe", "ignore", "ignore"],
  });
  procs.push(proc);

  // Poll the scratch path: proves the write mechanism actually fired (a
  // silently-broken register would leave BOTH paths absent, which must not
  // read as a pass).
  let wroteToScratch = false;
  for (let i = 0; i < 60; i++) {
    if (existsSync(scratchIdentityFile)) {
      wroteToScratch = true;
      break;
    }
    await Bun.sleep(100);
  }
  expect(wroteToScratch).toBe(true);
  expect(existsSync(realIdentityFile)).toBe(false);
}, 15_000);
