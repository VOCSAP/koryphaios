# Runbook: project_key case-normalization migration (card 69e5a3e0)

Written for the operator, ALONE, at a terminal, with no agent and no
Koryphaios session left to ask. Every step names the exact command, the
MACHINE it runs on, and what a healthy result looks like. Each factual claim
is labeled:

- **MESURE** -- run and observed, or read directly from a primary source
  file, during this session (command or file cited).
- **DEDUIT** -- read directly from this repo's source or docs, cited by
  `file:line`.
- **NON MESURE** -- could not be checked from this session. A discovery
  command is given instead of a guessed value. **Never substitute a guess
  for a NON MESURE value.**

Revision history: this is revision 3. Revision 1 assumed the sqlite file
was directly reachable on the broker host (wrong). Revision 2 assumed it
sat in an opaque Docker volume requiring `docker cp` extraction (also
wrong, but closer, and its WAL-handling mechanism carries over unchanged).
The operator supplied the actual `docker-compose.yml` and
`Dockerfile.claude-peers` (2026-08-20), which settle it: **it is a bind
mount**, directly visible on the host filesystem. All `docker cp`
extraction/reinjection machinery is gone from this revision.

## Two things to hold in mind through every section below

- **The script must never touch `notify.key`.** Guaranteed structurally,
  not by discipline: `scripts/migrate-project-key-case.ts` only ever opens
  the ONE file path passed via its `--db` flag (`bun:sqlite`'s `Database`
  constructor opens exactly that path and nothing else in the directory).
  `notify.key` is backed up alongside it (whole-directory backup below) but
  is never opened, read, or written by the migration.
- **Order matters between the surfaces**: move `koryphaios-mcp` (surface 1)
  AND rebuild Koryphaios (surface 2) BEFORE relaunching anything. A session
  spawned from either surface still on the old code re-splits the scope the
  migration just unified, immediately and silently.

## Three deployment surfaces -- enumerate all three, every time

A surface skipped here is the migration defeated in silence later, by
whichever surface nobody thought to move.

1. **The agent-side MCP clone**, `C:\Users\Olivier\workspace\koryphaios-mcp`
   -- **MUST MOVE**. MESURE (see "The machines involved" below): every
   Claude Code session's `claude-peers` MCP server runs from here, in
   DETACHED HEAD state, and does not advance on its own.
2. **The Koryphaios Deck app itself** (`kory`, main-process code including
   `desktop/src/main/roadmap-service.ts`) -- **MUST REBUILD**. MEASURED:
   `desktop/package.json:5` (`"main": "out/main/index.js"`) and
   `desktop/bin/launch.js:42-43` (`kory` spawns Electron against
   `appRoot`, which resolves that BUILT `out/main/index.js` -- the launcher
   script's own comment says "Build it first with `npm run build`"). `kory`
   runs from the interactive checkout (`C:\Users\Olivier\workspace\koryphaios`,
   branch `experimental`), so it already has the new commit's SOURCE once
   pushed -- but nothing rebuilds `out/` automatically, so the OLD compiled
   `computeDeckProjectKey` keeps running until `npm run build` is re-run.
3. **The host clone that builds the broker's Docker image** -- **DOES NOT
   MOVE, NOT NEEDED**. MEASURED (see "Does broker.ts need the fix" below):
   `broker.ts`'s entire transitive import closure (bundled, 18 modules)
   contains zero references to `normalizeRemoteUrl`, `computeProjectKey`,
   `computeDeckProjectKey`, or the two files that define them. The broker
   only stores and byte-compares whatever `project_key` string a client
   already computed -- it structurally cannot need this fix. No image
   rebuild, no host-clone update. The container is stopped/started only to
   release the sqlite file for the backup and migration, never to deploy
   new code.

## Does `broker.ts` need the fix -- measured, not assumed

```bash
bun build --target=bun broker.ts --outdir=/tmp/broker-closure-check
# -> "Bundled 18 modules"
grep -c "project-key\|summarize\|normalizeRemoteUrl\|computeProjectKey\|computeDeckProjectKey" /tmp/broker-closure-check/broker.js
# -> 0
```
`bun build` inlines a module's ENTIRE transitive closure into one file, so a
zero-count grep over the bundled output is a direct measurement of "does
this symbol or file appear anywhere broker.ts can reach", not an inference
from reading import statements by eye. Confirmed independently by
`Dockerfile.claude-peers`'s own build-comment (lines 25-29): "broker.ts n'a
AUCUNE dependance npm. Sa fermeture transitive (16 fichiers) ne reference
que des chemins relatifs et les builtins bun:sqlite, node:crypto, node:fs,
node:os, node:path" -- shared/ and notify/ are copied WHOLE into the image
(including shared/project-key.ts and shared/summarize.ts, since the
Dockerfile copies the directories, not a file list), but Bun only actually
loads what is imported, and broker.ts never imports either.

## The machines and the LXC/container involved

- **This PC** (hostname `DESKTOP-7B2CIVN`, MESURE via `hostname`): runs
  Koryphaios and every Claude Code session. There is only ONE client PC in
  this deployment -- every peer seen in `bun cli.ts status` reports host
  `desktop-7b2civn-*` (MESURE, `bun cli.ts status` output, 2026-08-20).
- **The broker's LXC host**, `192.168.10.23:7899` (MESURE, `bun cli.ts
  status` -> `URL: http://192.168.10.23:7899`, 2026-08-20). A SEPARATE
  machine, running the container below via `network_mode: host`.
- **The `claude-peers-broker` container** -- MEASURED from
  `docker-compose.yml` and `Dockerfile.claude-peers` (both read directly,
  2026-08-20, paths: `Local-Firewall_Desktop\Local-Firewall (1)\config\mcp-server\`):
  - `container_name: claude-peers-broker`, image
    `mcp-server/claude-peers-broker:0.9.0`.
  - **Bind mount** `/var/lib/mcp/claude-peers` (host) `:` `/var/lib/claude-peers`
    (container). The host path is the one you act on directly -- no
    `docker cp` needed for anything in this runbook.
  - `CLAUDE_PEERS_DB=/var/lib/claude-peers/peers.db` set explicitly in the
    compose `environment:` block -- so, as seen from the host,
    **`/var/lib/mcp/claude-peers/peers.db`**.
  - The bind-mounted directory also holds **`notify.key`** (AES-256-GCM key
    encrypting notification-channel tokens, `docker-compose.yml:32-36`,
    `Dockerfile.claude-peers:40-43`) and a `logs/` subdirectory. **Back up
    the whole directory. The migration script must never touch
    `notify.key`** -- structurally guaranteed, since the script only ever
    opens the ONE file path passed via its `--db` flag (`bun:sqlite` opens
    exactly that path, nothing else in the directory).
  - `read_only: true` on the container's rootfs -- only the bind mount and
    a 32 MB `/tmp` tmpfs are writable inside the container.
  - Image has `bun` (`FROM oven/bun:1.3.14-debian`,
    `Dockerfile.claude-peers:12`).
- **Two git checkouts on this PC** -- surfaces 1 and 2 above:
  - `C:\Users\Olivier\workspace\koryphaios` (MESURE, `git rev-parse
    --abbrev-ref HEAD` -> `experimental`): the interactive working copy.
    Commits happen here; the Deck app (`kory`) also runs from here, but
    from a BUILT copy that does not follow the source automatically.
  - `C:\Users\Olivier\workspace\koryphaios-mcp` (MESURE, `claude mcp list` ->
    `claude-peers: bun C:\Users\Olivier\workspace\koryphaios-mcp\server.ts`,
    then `git -C .../koryphaios-mcp status` -> `HEAD detached at 0774f5b`,
    remote `origin` -> `https://github.com/VOCSAP/koryphaios.git`): the
    clone EVERY Claude Code session's MCP `claude-peers` server actually
    runs from, registered globally (`--scope user`, README.md:153).
    DETACHED HEAD, pinned until moved.

## Order of execution

1. Team-lead pushes the commit containing `shared/project-key.ts` (the fix)
   and `scripts/migrate-project-key-case.ts` (the migration) to `origin`.
2. **Close Koryphaios and every open Claude Code session on this PC.** No
   writer may hold the broker while its DB is being backed up or migrated.
3. **Move the detached MCP clone onto the new commit** (surface 1, this PC).
4. **Rebuild Koryphaios** (surface 2, this PC): `cd desktop && npm run
   build`. Surface 3 (the broker's host clone / image) needs nothing --
   see the measured verdict above.
5. **Stop the `claude-peers-broker` container**, on the LXC host.
6. **Back up the whole `/var/lib/mcp/claude-peers` directory.** Mandatory,
   explicit step now (not structural, since there is no extraction step to
   piggyback on) -- first action after the stop, before any write.
7. **Dry-run the migration** against
   `/var/lib/mcp/claude-peers/peers.db`. See "Dry-run" below.
8. **Write the migration**, only if the dry-run was clean.
9. **Start the `claude-peers-broker` container**, confirm `/health`.
10. **Relaunch Koryphaios and sessions** on this PC. They now run the
    commit (and, for Koryphaios, the rebuild) from steps 3-4, so
    newly-registered peers compute the lowercase key that matches what
    step 8 just wrote -- no re-split.

## Where to run the migration script

`bun:sqlite` opens a local filesystem path only -- the script must run on a
machine that can see the file directly and has `bun` available.

**Primary: a throwaway `oven/bun:1.3.14-debian` container**, not a `bun`
install on the LXC host. Three reasons:

1. **Zero prerequisite on the host.** Whether the host itself has `bun`
   installed stops being a question at all.
2. **The exact same `bun` version that wrote the database.**
   `claude-peers-broker` is built `FROM oven/bun:1.3.14-debian`
   (`Dockerfile.claude-peers:12`) -- a host-installed `bun` could be a
   different version, and `bun:sqlite` is precisely the surface where a
   version drift would bite. This lot already hit one `bun:sqlite` quirk
   this same day (`{readonly: false}` alone threw "bad parameter or other
   API misuse" instead of opening read-write) -- not the moment to also mix
   two `bun` builds.
3. **`--rm`: nothing survives the command.** No install left behind, no
   state to clean up on the host.

```bash
# On the LXC host, container already stopped (step 5) and backup already
# taken (step 6):
docker run --rm \
  --user "$(stat -c '%u:%g' /var/lib/mcp/claude-peers)" \
  -v /var/lib/mcp/claude-peers:/var/lib/claude-peers \
  -v "$(pwd)/scripts/migrate-project-key-case.ts:/tmp/migrate.ts:ro" \
  oven/bun:1.3.14-debian \
  bun /tmp/migrate.ts --db /var/lib/claude-peers/peers.db
# add --write only after a clean dry-run, per "Dry-run"/"Write" below
```

**Two pre-flight checks, written here so the operator runs them, not
guessed:**

- **Is the image present or pullable?**
  ```bash
  docker images oven/bun:1.3.14-debian --format '{{.Repository}}:{{.Tag}}'
  ```
  Expect one matching line -- `claude-peers-broker`'s own image was built
  `FROM` this exact tag (`Dockerfile.claude-peers:12`), so a `docker build`
  of it necessarily pulled and locally tagged this base image already,
  and Docker keeps a still-referenced base image unless explicitly
  `docker rmi`'d. If the line is missing, `docker pull
  oven/bun:1.3.14-debian` (requires network egress from this host to
  Docker Hub -- **NOT MEASURED whether that egress is open**; if it is
  not, copy the image in by other means, or fall back to a host-installed
  `bun` if one exists, accepting the version-drift risk above).
- **Will the throwaway container be able to WRITE to the bind mount?**
  `--user "$(stat -c '%u:%g' /var/lib/mcp/claude-peers)"` above sidesteps
  needing to know the answer in advance: it makes the container run AS
  the same uid:gid that owns the host directory, whatever that is, so
  the write succeeds regardless. Run this first to see what it resolves
  to (informational, confirms the command above is doing something
  sane, not a guess):
  ```bash
  ls -lan /var/lib/mcp/claude-peers
  stat -c 'owner uid:gid = %u:%g' /var/lib/mcp/claude-peers
  ```
  **Verdict on the uid risk the team-lead flagged as most likely to bite:
  it will not, for two independent reasons.** First, the `--user` flag
  above removes the guesswork entirely. Second, even WITHOUT it: the
  upstream `oven/bun` Dockerfile (`oven-sh/bun`, `dockerhub/debian/Dockerfile`,
  read directly, 2026-08-20) creates a `bun` user (`useradd bun --uid 1000`)
  but never issues a `USER bun` directive -- the image's default user is
  root. `claude-peers-broker`'s OWN Dockerfile adds `USER bun` itself
  (`Dockerfile.claude-peers:47`) specifically to drop privileges for the
  long-running service; the bare `oven/bun:1.3.14-debian` image used here
  does not have that override, so `docker run` without `--user` runs as
  root, which has universal read-write access to a bind mount on a
  standard (non-userns-remapped) Docker install. The one residual
  NON MESURE is whether this host's Docker daemon uses `userns-remap` --
  uncommon, and checkable with `docker info --format '{{.SecurityOptions}}'`
  (look for `name=userns`) -- but the explicit `--user` flag above makes
  that check unnecessary rather than something to resolve first.

**Shortcut, if `which bun` succeeds on the host**: run
`bun scripts/migrate-project-key-case.ts --db
/var/lib/mcp/claude-peers/peers.db` directly, no container. Keep the
`docker run` form as the default -- it is the one that removes the
prerequisite question rather than depending on its answer.

## THE WAL TRAP -- still applies, read this before touching anything

`broker.ts:371` runs `db.run("PRAGMA journal_mode = WAL")` unconditionally
at boot (MESURE, `grep -n 'journal_mode' broker.ts`) -- this broker IS in
WAL mode. In WAL mode, the most recent committed transactions live in a
companion `peers.db-wal` file (and `peers.db-shm`), not yet folded into
`peers.db` itself. Copying only `peers.db` can silently miss the newest
writes.

**Stopping the container does NOT, by itself, guarantee those files get
merged.** Checked directly: `broker.ts` registers no `SIGTERM`/`SIGINT`
handler and calls `db.close()` nowhere (MESURE, `grep -n
'SIGTERM\|SIGINT\|db\.close' broker.ts` -> no matches; the only
`process.exit` calls are inside `uncaughtException`/`unhandledRejection`
handlers, `broker.ts:229-235`). `docker stop` sends SIGTERM then SIGKILL --
with nothing catching SIGTERM to close the database cleanly, there is no
guarantee of a clean checkpoint before the process dies. What stopping the
container DOES guarantee is that nothing is actively writing while you
back up or copy -- a CONSISTENT snapshot. Completeness comes from always
handling **all three files together** (`peers.db`, `peers.db-wal`,
`peers.db-shm`, whichever exist) and from the migration script's own
`Database(...)` open, which triggers SQLite's automatic WAL recovery.

## Backup (step 6, mandatory, explicit)

On the LXC host, container already stopped:

```bash
cp -a /var/lib/mcp/claude-peers /var/lib/mcp/claude-peers.pre-69e5a3e0.$(date +%Y%m%dT%H%M%SZ).bak
ls -la /var/lib/mcp/claude-peers.pre-69e5a3e0.*/
```
This copies the whole directory -- `peers.db` (+`-wal`/`-shm` if present),
`notify.key`, `logs/` -- in one shot, so nothing is forgotten. Keep it
until the migration is confirmed good in production (days, not hours).

## Dry-run (step 7)

```bash
docker run --rm \
  --user "$(stat -c '%u:%g' /var/lib/mcp/claude-peers)" \
  -v /var/lib/mcp/claude-peers:/var/lib/claude-peers \
  -v "$(pwd)/scripts/migrate-project-key-case.ts:/tmp/migrate.ts:ro" \
  oven/bun:1.3.14-debian \
  bun /tmp/migrate.ts --db /var/lib/claude-peers/peers.db
```
(Shortcut if `which bun` succeeds on the host: `bun
scripts/migrate-project-key-case.ts --db
/var/lib/mcp/claude-peers/peers.db` directly, no container -- see "Where to
run the migration script" above.)

A HEALTHY output (MESURE against synthetic `:memory:` fixtures in
`tests/migrate-project-key-case.test.ts`, not against this real db):

```
[migrate-project-key-case] db=/var/lib/claude-peers/peers.db mode=DRY-RUN
[migrate-project-key-case] discovered N table(s) with a project_key column:
  - approval_session_tokens
  - graph_drafts
  - peers
  - pending_approvals
  - roadmap_items
[migrate-project-key-case] no collision in any discovered table.
[migrate-project-key-case] before:
  approval_session_tokens: total=... mixed-case=... already-lower=... null-or-empty=...
  ... (one line per table)
[migrate-project-key-case] DRY-RUN: no write performed. Pass --write to commit.
```

**STOP and do not proceed to `--write`, message the team-lead, if you see
any of:**

- **Fewer than 5 discovered tables.** This card's own history is a hand-written
  table list that was short by one (`approval_session_tokens`) for two days
  -- if discovery ever again finds fewer than 5, something about the
  broker's schema differs from what this runbook assumes, not the reverse.
- **`REFUSING: ... collision detected` instead of the clean output above.**
  The script writes nothing when this fires (exit code 1) -- read the
  `table=... target="..." existing_forms=[...]` lines it prints and resolve
  manually; do not re-run with `--write` hoping it clears itself.
- **A `mixed-case` count of 0 across every table.** Either the fix is
  already applied (check you are not re-running against an
  already-migrated backup) or you pointed `--db` at the wrong file.
- **Any table you do not recognize from broker.ts's schema**, or one of the
  5 expected ones missing. Broker.ts is the sole schema owner in this repo
  (DEDUIT: `Grep 'CREATE TABLE' -glob '!node_modules/**'` returns only
  `broker.ts` among source files, plus tests with their own in-memory
  schemas and docs -- 2026-08-20), so an unexpected table name here means
  you are pointed at a DIFFERENT database than this repo's broker.

## Write (step 8)

Only after a clean dry-run, same command plus `--write`:

```bash
docker run --rm \
  --user "$(stat -c '%u:%g' /var/lib/mcp/claude-peers)" \
  -v /var/lib/mcp/claude-peers:/var/lib/claude-peers \
  -v "$(pwd)/scripts/migrate-project-key-case.ts:/tmp/migrate.ts:ro" \
  oven/bun:1.3.14-debian \
  bun /tmp/migrate.ts --db /var/lib/claude-peers/peers.db --write
```
(Shortcut form: `bun scripts/migrate-project-key-case.ts --db
/var/lib/mcp/claude-peers/peers.db --write` directly on the host, if `which
bun` succeeded earlier.)

Healthy output ends with `[migrate-project-key-case] done.` after an
`after:` block showing `mixed-case=0` on every table and a `changed N
row(s)` line per table. If it instead throws or exits non-zero, the
transaction (`db.transaction()`, `scripts/migrate-project-key-case.ts`) has
already rolled back -- the db is unchanged, safe to inspect and re-run once
the cause is fixed. Either way the container writes DIRECTLY to the bind
mount (no extraction, no copy-back) -- `--rm` removes the throwaway
container itself once it exits, nothing else to clean up.

There is no `docker exec` fallback in this revision: it would require the
container RUNNING, which reintroduces the exact live-writer risk the
stop-first discipline above exists to avoid, for no benefit over the
`docker run --rm` form (same image, same bind mount, no extra prerequisite).

## Restart (step 9)

```bash
docker start claude-peers-broker
curl http://127.0.0.1:7899/health
```
(add `-H "Authorization: Bearer $CLAUDE_PEERS_BROKER_TOKEN"` if the broker
requires it -- DEDUIT, README.md:436, `/health` is the one route exempted
from the bearer requirement, so this is likely unnecessary but harmless to
include).

## Relaunch (step 10)

Launch Koryphaios (rebuilt at step 4) and Claude Code sessions as usual, on
this PC. Then verify.

## Verify after

```bash
# From this PC, against the (now on the new commit) koryphaios-mcp clone:
bun cli.ts status
bun cli.ts roadmap-export "github.com/vocsap/koryphaios"
```
The second command must return a non-empty `items` array (MESURE, before
this fix `bun cli.ts roadmap-export "github.com/vocsap/koryphaios"`
returned `items: []` while `"github.com/VOCSAP/koryphaios"` had 231 items --
after a clean migration + a session on the fixed commit, the lowercase key
is the one that resolves). Re-running the migration script (dry-run is
enough) against the live path should show `mixed-case=0` on every table --
the script is idempotent (`tests/migrate-project-key-case.test.ts`,
"re-running --write after a successful migration is a no-op", MESURE,
2026-08-20).

## Rollback

The in-script transaction only protects a run that fails mid-way (auto
rollback, db left exactly as before). It does **not** protect against
"the migration succeeded but something downstream is now wrong" -- once
`--write` commits, the only way back is the backup from step 6:

```bash
docker stop claude-peers-broker
rm -rf /var/lib/mcp/claude-peers
cp -a /var/lib/mcp/claude-peers.pre-69e5a3e0.<timestamp>.bak /var/lib/mcp/claude-peers
docker start claude-peers-broker
```
Then move `koryphaios-mcp` back to its previous commit (`git -C
"C:\Users\Olivier\workspace\koryphaios-mcp" checkout <old-sha>`) and, if
Koryphaios was rebuilt in step 4, rebuild it again from the previous commit
too, so the running code and the restored (pre-fix, mixed-case) db agree
again.
