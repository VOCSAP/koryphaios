// Card c7185135 (vector half): scrubEnv now redirects HOME/USERPROFILE, not
// just APPDATA/XDG_CONFIG_HOME. A test that only asserts on the returned env
// OBJECT would pass even if server.ts ignored the redirected vars -- this
// spawns a real server.ts and checks the FILESYSTEM SIDE EFFECT it produces
// (shared/peer-cache.ts's session-identity file), the actual property being
// protected.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, scrubEnv, type TestBroker } from "./_helper.ts";
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
  const proc = Bun.spawn(["bun", "server.ts"], {
    env: scrubEnv(scratch, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
      CLAUDE_PEERS_DESK_SESSION: token,
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
