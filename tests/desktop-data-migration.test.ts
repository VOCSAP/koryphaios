import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pure module (node builtins only), so it imports cleanly under bun.
import {
  runDataMigration,
  APP_STATE_SUBDIR,
  MIGRATION_MARKER_SUBDIR
} from "../desktop/src/main/migrate-data-dir.ts";

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-migrate-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test("copies legacy deck app state into <userData>/config", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(deck, { recursive: true });
  writeFileSync(join(deck, "config.json"), JSON.stringify({ theme: "light" }), "utf-8");
  writeFileSync(join(deck, "sessions.json"), JSON.stringify([{ id: "a" }]), "utf-8");

  runDataMigration({ userDataDir: desk });

  const cfg = join(desk, APP_STATE_SUBDIR, "config.json");
  expect(existsSync(cfg)).toBe(true);
  expect(JSON.parse(readFileSync(cfg, "utf-8")).theme).toBe("light");
  expect(existsSync(join(desk, APP_STATE_SUBDIR, "sessions.json"))).toBe(true);
});

test("never overwrites an existing destination (idempotent)", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(deck, { recursive: true });
  mkdirSync(join(desk, APP_STATE_SUBDIR), { recursive: true });
  writeFileSync(join(deck, "config.json"), JSON.stringify({ theme: "light" }), "utf-8");
  writeFileSync(join(desk, APP_STATE_SUBDIR, "config.json"), JSON.stringify({ theme: "dark" }), "utf-8");

  runDataMigration({ userDataDir: desk });
  runDataMigration({ userDataDir: desk }); // a second run stays a no-op

  const cfg = JSON.parse(readFileSync(join(desk, APP_STATE_SUBDIR, "config.json"), "utf-8"));
  expect(cfg.theme).toBe("dark"); // preserved, not clobbered
});

test("no-op when the legacy deck folder is absent", () => {
  const parent = tmpRoot();
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(desk, { recursive: true });

  runDataMigration({ userDataDir: desk });

  expect(existsSync(join(desk, APP_STATE_SUBDIR, "config.json"))).toBe(false);
});

test("does not touch a launch config.json sitting at the desk root", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(deck, { recursive: true });
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(deck, "config.json"), JSON.stringify({ theme: "light" }), "utf-8");
  // The launch config lives at the desk root (NOT under config/) and must be
  // left untouched by the userData migration.
  const launch = join(desk, "config.json");
  writeFileSync(launch, JSON.stringify({ launchCommand: "claude run" }), "utf-8");

  runDataMigration({ userDataDir: desk });

  expect(JSON.parse(readFileSync(launch, "utf-8")).launchCommand).toBe("claude run");
  expect(JSON.parse(readFileSync(join(desk, APP_STATE_SUBDIR, "config.json"), "utf-8")).theme).toBe(
    "light"
  );
});

// --- Card eda86400: a no-overwrite copy is idempotent against OVERWRITE, and a
// permanent RE-SEED against DELETION. runDataMigration runs at every app start
// (index.ts top level), so before the sentinel any file the operator deleted was
// copied back from the legacy root at the next boot. Measured on the operator's
// machine: %APPDATA%/koryphaios/templates/template_full.json carried the mtime of
// that morning's relaunch with an md5 identical to the legacy copy dated a month
// earlier. The pre-existing "never overwrites an existing destination" test above
// covers the OVERWRITE half only; these cover the DELETION half.

test("a deleted template is not resurrected by the next boot (desk -> koryphaios)", () => {
  const parent = tmpRoot();
  const desk = join(parent, "claude-peers-desk");
  const kory = join(parent, "koryphaios");
  mkdirSync(join(desk, "templates"), { recursive: true });
  mkdirSync(kory, { recursive: true });
  writeFileSync(
    join(desk, "templates", "template_full.json"),
    JSON.stringify({ name: "full", sessions: [] }),
    "utf-8"
  );

  runDataMigration({ userDataDir: kory }); // boot 1 seeds it
  const copied = join(kory, "templates", "template_full.json");
  expect(existsSync(copied)).toBe(true);

  rmSync(copied, { force: true }); // the operator deletes it from the picker

  runDataMigration({ userDataDir: kory }); // boot 2: relaunch

  expect(existsSync(copied)).toBe(false);
});

test("a fresh install still receives the full legacy desk copy (negative control)", () => {
  const parent = tmpRoot();
  const desk = join(parent, "claude-peers-desk");
  const kory = join(parent, "koryphaios");
  mkdirSync(join(desk, "templates"), { recursive: true });
  mkdirSync(kory, { recursive: true });
  writeFileSync(join(desk, "templates", "TeamStd.json"), JSON.stringify({ name: "std", sessions: [] }), "utf-8");
  writeFileSync(join(desk, "config.json"), JSON.stringify({ launchCommand: "claude" }), "utf-8");

  runDataMigration({ userDataDir: kory });

  // Guards the fix from "succeeding" by disabling the migration outright.
  expect(existsSync(join(kory, "templates", "TeamStd.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(kory, "config.json"), "utf-8")).launchCommand).toBe("claude");
});

test("a deleted sessions.json is not resurrected by the next boot (deck -> userData)", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const kory = join(parent, "koryphaios");
  mkdirSync(deck, { recursive: true });
  mkdirSync(kory, { recursive: true });
  writeFileSync(join(deck, "sessions.json"), JSON.stringify([{ id: "a" }]), "utf-8");

  runDataMigration({ userDataDir: kory }); // boot 1
  const copied = join(kory, APP_STATE_SUBDIR, "sessions.json");
  expect(existsSync(copied)).toBe(true);

  rmSync(copied, { force: true });

  runDataMigration({ userDataDir: kory }); // boot 2

  expect(existsSync(copied)).toBe(false);
});

test("no sentinel is written when the legacy folder is absent (a later one still migrates)", () => {
  const parent = tmpRoot();
  const desk = join(parent, "claude-peers-desk");
  const kory = join(parent, "koryphaios");
  mkdirSync(kory, { recursive: true });

  runDataMigration({ userDataDir: kory }); // boot 1: nothing to migrate yet

  expect(existsSync(join(kory, MIGRATION_MARKER_SUBDIR, "desk-to-koryphaios"))).toBe(false);

  // The legacy root shows up afterwards (rollback to an older build, restore
  // from a backup). Marking it done above would have skipped it forever.
  mkdirSync(join(desk, "templates"), { recursive: true });
  writeFileSync(join(desk, "templates", "TeamStd.json"), JSON.stringify({ name: "std", sessions: [] }), "utf-8");

  runDataMigration({ userDataDir: kory }); // boot 2

  expect(existsSync(join(kory, "templates", "TeamStd.json"))).toBe(true);
});

// --- Review round 2 (card eda86400). The sentinel introduced above answers the
// resurrection bug but opens the mirror failure, which fails CLOSED and silently:
// marking a migration done when it copied NOTHING. Two shapes are pinned here,
// plus the invariant the sentinel rests on ("written only after a copy that
// succeeded"), which two mutations -- moving markMigrationDone before the copy,
// and deleting the `failed` flag -- were measured to leave green.

test("an empty legacy desk root writes no sentinel (a later refill still migrates)", () => {
  const parent = tmpRoot();
  const desk = join(parent, "claude-peers-desk");
  const kory = join(parent, "koryphaios");
  mkdirSync(desk, { recursive: true }); // present, but nothing in it yet
  mkdirSync(kory, { recursive: true });

  runDataMigration({ userDataDir: kory }); // boot 1: nothing to copy

  expect(existsSync(join(kory, MIGRATION_MARKER_SUBDIR, "desk-to-koryphaios"))).toBe(false);

  // The legacy root is refilled afterwards: a rollback to an older build, or a
  // backup restored into it. This is the case copy-not-rename exists for.
  mkdirSync(join(desk, "templates"), { recursive: true });
  writeFileSync(join(desk, "templates", "TeamStd.json"), JSON.stringify({ name: "std", sessions: [] }), "utf-8");

  runDataMigration({ userDataDir: kory }); // boot 2

  expect(existsSync(join(kory, "templates", "TeamStd.json"))).toBe(true);
});

test("an empty legacy deck root writes no sentinel (a later refill still migrates)", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const kory = join(parent, "koryphaios");
  mkdirSync(deck, { recursive: true }); // no config.json, no sessions.json
  mkdirSync(kory, { recursive: true });

  runDataMigration({ userDataDir: kory }); // boot 1

  expect(existsSync(join(kory, MIGRATION_MARKER_SUBDIR, "deck-userdata"))).toBe(false);

  writeFileSync(join(deck, "sessions.json"), JSON.stringify([{ id: "a" }]), "utf-8");

  runDataMigration({ userDataDir: kory }); // boot 2

  expect(existsSync(join(kory, APP_STATE_SUBDIR, "sessions.json"))).toBe(true);
});

test("a desk copy that throws writes no sentinel", () => {
  const parent = tmpRoot();
  const desk = join(parent, "claude-peers-desk");
  const kory = join(parent, "koryphaios");
  mkdirSync(join(desk, "templates"), { recursive: true });
  writeFileSync(join(desk, "templates", "TeamStd.json"), JSON.stringify({ name: "std", sessions: [] }), "utf-8");
  mkdirSync(kory, { recursive: true });
  // A FILE where the source has a DIRECTORY: cpSync raises
  // ERR_FS_CP_DIR_TO_NON_DIR, which force:false does not suppress.
  writeFileSync(join(kory, "templates"), "not a directory", "utf-8");

  runDataMigration({ userDataDir: kory });

  expect(existsSync(join(kory, MIGRATION_MARKER_SUBDIR, "desk-to-koryphaios"))).toBe(false);
});

test("a deck copy that throws writes no sentinel", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const kory = join(parent, "koryphaios");
  mkdirSync(deck, { recursive: true });
  writeFileSync(join(deck, "sessions.json"), JSON.stringify([{ id: "a" }]), "utf-8");
  mkdirSync(kory, { recursive: true });
  // <userData>/config is a FILE, so mkdirSync(destDir) throws and the entry is
  // skipped: the migration must stay unmarked and retry at the next launch.
  writeFileSync(join(kory, APP_STATE_SUBDIR), "not a directory", "utf-8");

  runDataMigration({ userDataDir: kory });

  expect(existsSync(join(kory, MIGRATION_MARKER_SUBDIR, "deck-userdata"))).toBe(false);
});

// The file header claims the migrations are "chained oldest-first". Nothing
// pinned that: swapping the two calls in runDataMigration left the suite green
// while silently making the OLDEST app state win, on the app's own config file.
// Both legacy roots carry an app-state config.json here; desk is the recent one
// and must be the one that lands.
test("the desk state wins over the deck state when both legacy roots exist", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const desk = join(parent, "claude-peers-desk");
  const kory = join(parent, "koryphaios");
  mkdirSync(join(desk, APP_STATE_SUBDIR), { recursive: true });
  mkdirSync(deck, { recursive: true });
  mkdirSync(kory, { recursive: true });
  writeFileSync(
    join(desk, APP_STATE_SUBDIR, "config.json"),
    JSON.stringify({ theme: "desk-recent" }),
    "utf-8"
  );
  writeFileSync(join(deck, "config.json"), JSON.stringify({ theme: "deck-ancient" }), "utf-8");

  runDataMigration({ userDataDir: kory });

  const landed = JSON.parse(readFileSync(join(kory, APP_STATE_SUBDIR, "config.json"), "utf-8"));
  expect(landed.theme).toBe("desk-recent");
});
