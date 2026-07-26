# Changelog

## core + desktop (experimental) — remote approvals: answer a waiting session from your phone

Long sessions stop and wait: a tool-permission dialog, a plan to approve, an
open question. Until now that meant walking back to the machine. An agent's
blocking question can now reach the operator over **Telegram** or **Discord**,
and the answer comes back as **free text** — not a yes/no.

**The broker is the sole arbiter.** `POST /approval/claim` is a conditional
`UPDATE ... WHERE status='pending'`, so exactly one caller wins and every other
gets 409. That single line is what makes "answered in the Deck" and "answered
on the phone" mutually exclusive; the losing copies are rewritten to "handled
via X" and lose their buttons, so nothing stale keeps looking actionable.
Approvals are parked with the `graph_drafts` durability model (no FK, plain
snapshots, status flips, non-destructive listing): neither a broker nor a Deck
restart loses one. Only the NOTIFICATION expires (24 h, tunable) — the session
stays blocked and the Deck can still settle it.

**A new identity axis, because `hostname()` names a machine, not a person.**
Two OS accounts on one PC share a hostname, so routing by host would hand
account B's approvals to account A. `operator_id` is the digest of an Ed25519
PUBLIC key; the broker stores that half only, so the binding is self-certifying
(another key for a known id would need a collision) and reading the broker's
SQLite file lets nobody act as anyone. Proofs carry a nonce and a timestamp and
are single-use, which closes backlog **B8** (replay) for this endpoint family
rather than inheriting it. The compartmentalisation itself costs no code: the
app-state directory is already per OS user, so two accounts mint two
identities. Two PCs, conversely, can share one identity by scanning a one-shot
link code — the phone is paired once, for the person.

**Two credential classes, deliberately asymmetric.** The operator key (Deck
only) is alone in being able to `claim` — the operation that authorises a tool
call. A per-session token, handed to spawned agents *including inside a sandbox
container*, may only `add` and `wait`. Worst case for a compromised sandboxed
agent: it spams its own operator with notifications. Had it held the operator
key it could have answered OTHER sessions' approvals, including non-sandboxed
ones on the host — a clean authority escape.

**Three producers, because the kinds of question differ.** The embedded
plugin's `PermissionRequest` hook fires only when a dialog actually appears
(`PreToolUse` would fire on every tool call) and carries a structured payload,
which beats scraping the screen. It does NOT block: Claude Code is already
waiting on its own dialog and keeps waiting, so holding the hook process open
for minutes bought nothing and raised a question — how long may a hook legally
block? — that the documentation does not answer. The `ask_operator` /
`ask_operator_wait` MCP tools cover open questions, which no hook reaches
(there is none for `AskUserQuestion` or plan approval); the tool's return value
IS the answer, and a ticket makes waiting resumable so no single call depends
on the client's timeout. `attention.ts` remains the net for CLIs without hooks.
Everything fails CLOSED: no credential, broker down or budget spent yields no
decision at all, and the native dialog stands.

**Two return paths, and the split is not stylistic.** A permission dialog is
NOT closed by an incoming message — the UI loop is blocked on a keypress and
the message merely queues (verified in use). So `reply_route` is an explicit
field: `channel` hands the answer to the peer as an ordinary claude-peers
message from the reserved `operator` sentinel when the agent is at its prompt;
`pty` types it in when the agent sits on a modal, or when the CLI has no push
channel at all (codex and gemini have no `claude/channel` equivalent). A
`channel` route whose peer is not active is downgraded to `pty` at creation
rather than accepting a route that can never deliver. This is what makes the
feature reach sessions the Deck does not own: a plain `claude` in a terminal,
or one on another machine sharing the broker. On the agent side the message
gets its own framing — actionable, but explicitly not to be acknowledged, or
every settled approval would drop an "ok, doing it" into the operator's inbox.
The global no-reply instruction is untouched; as the existing
`DECK_NO_REPLY_NOTE` comment says, the nuance rides in the rendered content.

**Gateways in the broker, tokens enrolled from the app.** Telegram allows
exactly one `getUpdates` consumer per token, so the gateway must be a singleton
— the broker, not the N Decks. But requiring shell access to the broker host to
paste a token was not an experience worth shipping, and many operators do not
have that access. The token therefore travels once over an operator-signed
route and is sealed with AES-256-GCM beside the database; it is never read
back, only a four-character hint of it. Both transports are OUTGOING (long
polling, Gateway WebSocket): no port is opened, no address published. Telegram
pairs through a deep link rendered as a QR; for Discord the app reads the
application id straight from the token to build the invite URL, so the operator
never copies it from the portal — and that link is shown FIRST, because without
a mutual server a bot cannot DM anyone (error 50278).

**Hostile inputs, each named.** The question text comes from an AGENT and
reaches a third-party renderer, so it is escaped (Telegram in HTML mode: three
characters, against MarkdownV2's eighteen and its silent 400s). The answer comes
from a remote channel and ends up typed into a terminal, so every CR/LF
collapses to a space and the submitting Enter is added by the code — a remote
answer can never submit early nor run a second command. `reply_token` joins
`instance_token`/`from_token`: it enters by `add`, lives in the database, never
returns. And four of the five new IPC channels are blocked for a paired phone:
one of them exports the enrolment payload, which CONTAINS the operator private
key, and a single companion pairing must not become a permanent identity theft.

**Three defects the tests found on the way.** `deriveOperatorId` and
`deriveTokenId` shared a hash space (domain separation added). The hook's
`idle_prompt` and the Deck's attention detector raised TWO approvals for one
screen, so the phone rang twice (a tile can only wait on one thing at a time —
a second raise now returns the first). And the verdict poller's "still waiting"
check only recognised Deck-raised approvals, so every hook verdict would have
been silently dropped.

886 tests at delivery (+159), none of which touches the network: the gateways
are exercised with a fake channel, against a real broker, a real peer
WebSocket, the hook as a real subprocess and the MCP tool over real JSON-RPC
stdio. Real-world validation — the two bots, cross-channel arbitration, two OS
accounts, two linked PCs — is listed in `BACKLOG.md` §3.1 bis. Operator
documentation: `desktop/docs/notifications.md`. The mobile app as a third
channel (lot N5) is not started.

## desktop (experimental) — sandbox hardening: nine review findings, one of them a sandbox escape

A code review of the sandbox lot found nine real defects. All are fixed, each
with a regression test — the first round shipped green tests that could not
have caught any of them, because they covered the pure modules while every bug
lived in the INTERACTIONS between them.

**The escape (critical).** The host `~/.claude/peers` was bind-mounted
read-write into every container so the containerized `server.ts` could write
its session-id back-channel. That let a sandboxed agent overwrite the
back-channel file of a NON-sandboxed tile: `readDeskSessionId` returned the
file's content verbatim (only the *token* was sanitized, never the value) and
`session-command.ts` interpolated it unquoted as `--resume ${id}` — payload
executing in the HOST shell. Three locks now, because one of them will
eventually be wrong: containers get a Deck-owned `sandbox-peers/` dir instead
of the host one (host tiles are simply out of reach), `readDeskSessionId`
drops anything outside the `[A-Za-z0-9-]{1,64}` shape the core guarantees, and
both id flags are quoted. `SessionService` resolves the back-channel/peer-cache
dir per session, so the supervisor keeps the host dir it needs.

**Silent wrongness (high).** `mapHostPathToContainer` fell back to `/work` for
any path not textually under the mount — combined with the new `canonicalPath`
on worktrees, a symlinked project prefix (macOS `/var`) ran every worktree
session in the project ROOT. It now returns null and the spawn is refused with
a trace, and the mount source is canonicalized so the comparison matches in the
first place. `walkProjectFiles` followed symlinks (`statSync`, no visited set),
so copy-mode globs could pull files from outside the repo and a
self-referential link spun the main process forever — the file cap could not
help, a link loop yields no files. It now uses `lstatSync`, skips links
outright and bounds visits. `ensure()` reused a container whose `/work` mount
belonged to the other work mode, so a failed rebuild after switching to
*ephemeral copy* left agents writing the real tree while the UI said otherwise;
the mount is now compared and the container recreated when stale.

**Broken features (medium).** `transcriptsFor` returned `[]` — a positive
claim of "no transcript" — for any cwd never refreshed, and the cache was only
warmed for the project root: every worktree resume silently started fresh. It
returns null (= "ask the host") and the cache is warmed for the cwd each
session will really use, including on workspace restore. `resetCopy` rm -rf'd
the live bind-mount source without recreating the container, leaving `/work`
on a deleted inode; it now recreates. Published ports were a fixed list
identical for every project with no UI to change them, so a second sandboxed
project could never start — the ports are now editable in the Docker view, an
explicitly empty list is honoured, and the collision is named in the error.

**Dead code and noise (low).** Auth "Disconnect" guarded on "no container
running" while the wipe itself is a `docker exec` needing one — mutually
exclusive states, so no call could ever succeed; it now guards on live
sessions. And `[A-Za-z]:[\\/]` matched the `s:/` inside `https://`, flagging
every hook containing a URL as un-runnable in the container.


## desktop (experimental) — green CI on all three runners (M-MNT-4)

`desktop-build` had been red on macOS and Windows for weeks (8 failing tests
on Windows, 4 on macOS, 1 on Linux) with no diagnosis written down. All of it
is fixed; the causes were three distinct things, only one of which was a test
artifact.

**A real product bug on symlinked paths.** `worktree-service` compared its own
`resolve()`d paths against the ones **git** reports, and git always reports the
REAL path. On macOS `/var` is a symlink to `/private/var`, on Windows a path can
arrive as an 8.3 short name (`C:\Users\RUNNER~1\…`) — so `removeWorktree`
answered *"not a worktree of this repo"* for a worktree it had just created, and
the Worktrees view could not attach a session to its worktree. Every comparison
now goes through `canonicalPath` (`realpathSync.native`, falling back to
`resolve` for paths that do not exist so a missing path still yields the
caller's own error). `ipc.ts` uses it on the session side of the
worktree↔session match too, for the same reason. This was invisible on Linux
because its tmpdirs are not symlinked — so the suite now creates a symlinked
repo prefix explicitly and drives create/list/remove through it, a test that
fails without the fix on any OS.

**Two POSIX-shaped assertions.** The digest suite probed the working directory
with `pwd` (no such builtin in cmd.exe) and compared with `dir.split("/")`; it
now prints the cwd through node and compares canonically. The utility-inference
suite matched the stdin redirection with `/< "file"$/`, which is the POSIX form
— the PowerShell form (`Get-Content -Raw "file" | …`) is equally correct, so the
assertion accepts either and asserts the document contract instead of one OS's
syntax.

**Two tests that are POSIX by construction.** The `runHelp` round-trips pin
`platform: "linux"` and drive a `#!/bin/sh` fixture through `shell: "/bin/sh"`;
there is no `/bin/sh` to run them against on Windows and they assert nothing
about it. They are now skipped there — and rather than leave Windows less
covered, two new OS-agnostic tests exercise the same executor (marker
stripping, stdout capture, rejection on a command that cannot run) with
constructs that behave identically in sh and PowerShell.


## desktop (experimental) — Sandbox mode M2/M3: operator config projection, supervisor exec, ephemeral copy mode

Second sandbox lot: the remaining design is folded into this entry (the
working plan file was consolidated away per repo convention). The remote
SSH/Proxmox backend was ABANDONED — Docker covers the need.

**Your workflow travels into the container (M2).** At every container start
the Deck COPIES the operator's `~/.claude` allow-list — global `CLAUDE.md`,
`agents/`, `skills/`, `plugins/`, `settings.json` — into the sandbox
(`sandbox-projection.ts`, `docker cp`), and the Docker view reports exactly
what landed. Copy, never mount, and the header says why: a mounted
`settings.json` would let a sandboxed agent write a hook that later executes
on the HOST, a clean escape. Hooks that cannot run under Linux (PowerShell,
`.ps1/.bat/.exe`, `C:\…`) are detected and listed, with a
`~/.claude/sandbox-overrides/` overlay to supply Linux equivalents (a
same-named entry there wins); overlay files that are not projectable are
reported instead of silently ignored.

**The supervisor manages the environment (M2).** New `deck_sandbox_exec`
tool: "add this dependency to the instance" runs inside the project's
container, in `/work`, with the agent's command line passed as ONE argv
element to the CONTAINER's bash — it never reaches a host shell (hostile
input #4). Refused when sandbox mode is off, 5-min cap, clipped output,
journaled.

**Honest environment reporting (M2).** The broker bridge is no longer guessed
from the platform: the view curls `/health` FROM inside the container and
reports what happened, with the `CLAUDE_PEERS_BIND_HOST` fix spelled out when
a native Linux engine can't reach the host. The image is probed
(`image inspect`) and buildable in one click — `docker build` on the shipped
Dockerfile runs in a real utility PTY so the build log is readable — and a
drift badge appears when the image was rebuilt after the container was
created. Resume now works inside the sandbox: transcripts live in the auth
volume, so the Deck lists them container-side (`find …/projects/<container
cwd>`) and `SessionService` consults that instead of the host's — surviving
even a container rebuild. Plus auth "Disconnect" (refused while a sandbox
container runs).

**Ephemeral copy mode (M3).** A per-project work mode: instead of the real
tree, the Deck mounts a throwaway `git clone --local` of it, so agents cannot
touch the project at all and work leaves through git (the clone's `origin` IS
the local repo). Because a clone only carries tracked files, an operator
allow-list of gitignored globs is copied on top (planning notes, local
fixtures) — with a hard deny-list that always wins (`.env*`, keys/certs,
`.ssh`, `.aws`, `node_modules`, `.venv`, `.git`) and unmatched globs surfaced
so a typo is visible. The pre-spawn gate now returns the EFFECTIVE project
root, so tile cwds and `git worktree add` land inside the mounted clone.

Settings moved to a single guarded `sandbox:patch-settings` channel (enable,
work mode, ports, globs — all trust-changing, all refused while sessions
run, all `REMOTE_BLOCKED`). Docs: `desktop/docs/sandbox.md` rewritten,
overview/sessions/settings/supervisor-team/faq updated, both READMEs.
Residual is field validation only — the checklist lives in `BACKLOG.md`
§3.8. The remote SSH / Proxmox backend once sketched for M3 is dropped: the
local engine covers the need.

## desktop (experimental) — Sandbox mode M1: sessions in a persistent per-project Docker container (SBX1–SBX5)

New 🏺 **Docker** rail view + per-project toggle: with sandbox mode on, every
NEW session runs inside a persistent container (`kory-sbx-<sha256(projectDir)
[0..12]>`, project bind-mounted rw at `/work`, idling on `sleep infinity`) —
the tile PTY simply runs `docker exec` and every detector (thinking, quota,
attention) works unchanged. The wrap goes through a per-session launch script
under a Deck-owned `/kory-run` mount (no PowerShell→bash double-quoting; env
translated by pure, bun-tested `sandbox-command.ts`: FORCE_GROUP file→inline,
loopback URLs→`host.docker.internal`). Sessions inside reach the HOST broker
via an injected `CLAUDE_PEERS_BROKER_URL` (server.ts refuses to auto-spawn on
non-loopback, so a bad bridge fails loudly); the host `~/.claude/peers` dir is
bind-mounted so peer-id discovery and the desk-session back-channel keep
working. The supervisor stays host-side (exempt by design — it pilots the app).

Auth is a shared named volume (`kory-claude-auth` on `~/.claude`): ONE CLI
login covers every project and survives container removal. First spawn with
no credentials opens a blocking modal — Next embeds an xterm running `claude`
in the container, the Deck polls the credentials file, closes the modal and
toasts on success; agents cannot spawn until then (`sandboxGate` in the
shared create path throws `sandbox-auth-required`, mapped renderer-side to
the modal — no login prompt per tile, ever). Re-authenticate lives in the
Docker view.

Lifecycle is Proxmox-LXC-like on purpose: containers are created lazily,
**stopped** (detached) at app close, **never** auto-removed; the Docker view
lists every `kory-sbx-*` container (all projects, labels `kory.sandbox` /
`kory.project`) with start/stop/rebuild/remove — all gated like the toggle on
`hasLiveSessions()`, names re-validated main-side against the generated shape
(hostile input #3). Settings (`enabled`, published dev-server ports for the
embedded browser) live in operator app-state `sandbox.json` keyed by
`computeDeckProjectKey` — never the repo. Image built once from
`desktop/resources/sandbox/Dockerfile` (debian + bash/git/bun + claude CLI,
user `kory`). Companion is transparent (all channels execute host-side; the
sandbox trust flips are `REMOTE_BLOCKED`). Design + M2/M3 milestones:
this entry; operator docs: `desktop/docs/sandbox.md`; field-validation
checklist: `BACKLOG.md` §3.8. Also fixes the calendar-rotted `desktop-log` prune test
(fixture age now anchored on the test's fixed clock).

## desktop (experimental) — Browser REC: screen recording + agent-driven demo scenarios

The embedded browser's toolbar gains a **REC** button: a modal picks the
capture scope — browser pane only (canvas-crop pipeline over the window
stream, pure math in `shared/recording.ts`) or the whole Koryphaios window —
and the clip lands under app-state `recordings/` as MP4 (when the Chromium
runtime muxes it) or WebM, path in a toast. `getDisplayMedia` is answered
main-side with the Deck's OWN window only (`setDisplayMediaRequestHandler` —
no OS picker, the renderer can never capture another surface); while
recording, the button pulses red with an elapsed timer and the browser rail
entry carries a red dot from every view.

The modal's optional **scripted scenario** makes the tool film itself being
useful: the operator describes what to show, picks a model (claude CLI only,
Sonnet default, remembered in `config.demoTarget` — the picker is in the
modal, not a hidden supervisor prompt), and ONE throwaway `claude -p` drives
the embedded page while the pane records, auto-stopping on completion. The
agent's whole capability surface is five `demo_*` MCP tools (structured
`demo_read`, `demo_navigate`, real-input `demo_click`/`demo_type`,
viewer-pacing `demo_wait`) served by a NEW per-run loopback endpoint + Bearer
token (`demo-control.ts` + `demo-browser-mcp.mjs`, mirroring deck-control but
least-privilege: never the supervisor token, 120-step cap, 64 KiB payloads).
Harness = C8 code constant (`demo-driver.ts`, scenario framed as data, every
file/shell/web tool disallowed); agent-supplied selectors/texts enter page
scripts JSON-encoded only (`browser-drive-scripts.ts`, bun-tested against
breakout payloads) and navigation is http(s)-only. Stopping the recording
cancels the run (killable child, login-shell PATH). deck-control was NOT
extended: the demo agent piloting a web page and the supervisor piloting the
app are different trust domains. Suite: demo-control dispatch/auth/step-cap +
stdio bridge end-to-end, script-builder escaping, command/harness composition
(tamper-overwrite included); pending real-runtime validations in
`BACKLOG.md` §2.

## desktop + core (experimental) — Directive cards: supervised context/token economy (CT)

A new roadmap kind **`directive`** turns the shared roadmap into a lever for
context-window economy across a team of sessions. A directive card carries a
closed-enum command — `clear` (free, zero-inference context reset; system
prompt / CLAUDE.md / MCP / skills survive), `compact` (summarize in place, one
inference on the target's own model), or `magic_compact` — plus an explicit
`target_peer_ids` list. When the card reaches the head of the operator's
dispatch queue, the **Deck itself types the command into the targeted
sessions' terminals** (the autoResume keystroke precedent: Escape → settle →
command → Enter, gated on the tile being idle so a reset never lands
mid-turn); agents never execute directives. Decide vs execute is split by
design: queueing a card is open to the operator (Workflow lane) and to the
team-lead / supervisor (`roadmap_add`, kind `directive`), but the injected
text is always a CODE CONSTANT (`directive.ts` DIRECTIVE_KEYS) chosen from the
re-validated enum — a manipulated lead can at worst trigger a spurious `/clear`
(C8 / three-hostile-inputs #2: broker fields re-validated Deck-side, never
typed verbatim). The conveyor belt drains leading directive cards before the
next work item, so a `clear` placed (or `depends_on`-wired) after an item runs
at that boundary; hand-off briefings for the next item ride the item's
`context` field, not the directive.

`magic_compact` prefers the aerovato Magic-compact plugin (deterministic,
zero-inference transcript compaction): the Deck injects `/magic-compact`,
captures the `/resume <id>` banner from the tile's own output (ANSI-tolerant,
strict-UUID), and re-enters the compacted session IN PLACE — option A, the
process never restarts so the peer_id and the launch harness are preserved —
falling back to standard `/compact` on the plugin's shim-failure message, a
timeout, or when the plugin is absent/disabled. Per-machine **feature flags**
(`resolveFeatures`): `magicCompact` (`auto`|`on`|`off`) reaches a PTY so the
GLOBAL config decides enablement and a project-local (clonable) config may only
restrict it to `off`; `handoff` (`file`|`kleos`|`off`) is advisory. Core:
broker `roadmap_items` gains `directive` + `target_peer_ids` (migration,
validation, sanitized peer-id list capped at 16, export/import); the
`roadmap_add`/`roadmap_update`/`roadmap_list` MCP schemas, the team playbook and
the supervisor briefing all learn the concept. UI: a distinct dashed-violet
card in the Workflow lane, a generic directive item in the editor (command
dropdown + live-peer target multiselect, work-only fields hidden), and the
detail modal, with EN/FR locale parity. Chantier ids: `CT1`…`CT7`
(chantiers CT1–CT7); the deferred `clear`+briefing / context-gauge increment
(CT6) and the option-A empirical checks live in `BACKLOG.md`.

## desktop (experimental) — Usage-limits modal (amphora rail button)

One rail button (amphora glyph — the level left in the jar), one foreground
modal stacking the subscription quota gauges of every DETECTED frontier CLI:
Claude Code (session 5 h + weekly all-models + weekly per-model + extra-usage
credits via `api.anthropic.com/api/oauth/usage`), Codex (5 h + weekly via
`codex app-server` JSON-RPC, local session-rollout fallback flagged stale) and
Antigravity (gemini/3p pools × 5h/weekly via cloudcode-pa
`retrieveUserQuotaSummary`, OS-keyring OAuth blob). Design decisions: a single
unified modal (comparison at a glance) rather than a per-provider submenu or
brand icons in the Greek-glyph rail; Gemini CLI deliberately excluded
(individual accounts cut by Google on 2026-06-18, migrated to Antigravity —
operator decision); all endpoints are reverse-engineered community mechanisms
(CodexBar / openusage / Usage-Monitor), an operator-approved risk mitigated by
per-provider degraded states ('not-connected' / 'error' / stale) and a 3-min
main-side cache (the Anthropic endpoint 429s aggressive polling). Tokens never
cross the IPC boundary. Chain: `usage-service.ts` → `usage:read` (tier 0) →
`UsageLimitsModal.tsx`; gauges amber past 70 %, red past 90 %.

Second wave of the lot: (1) **Antigravity as a model provider** — `agy` joins
the frontier catalog (GraphCli `antigravity`, provider id `antigravity`,
sigil `△`), executed headless through a "read this context file" instruction
+ `--add-dir` (no system/stdin flag documented) with `--print-timeout`, and
ALWAYS under a PTY (`pty-run.ts`, injected as `runTty`) because `agy -p`
hangs without a TTY (agy#318) and drops piped stdout (agy#76); model names
ship with their effort suffix ("Gemini 3 Pro (High)") through the dedicated
`sanitizeAntigravityModel` (double-quoted, spaces legal). Gemini CLI stays
wired unchanged for org accounts. (2) **The amphora becomes a gauge** — its
liquid level is the mean REMAINING session quota of the providers the app
run actually draws down (live tiles + marked inference targets,
`markProviderUsed` / `usedProviders` in the snapshot, math in
`shared/usage.ts`), polled every 5 min renderer-side through the 3-min main
cache; tone green / amber (≤30 %) / red (≤10 %) via `.usage-*` classes,
sanctioned as the one data-fill exception to the stroke-only glyph rule
(DESIGN.md §5).

## desktop (experimental) — Workflow lane: the dispatch queue as a visual chain

The roadmap view splits horizontally: kanban on top, a new **Workflow lane**
below (`WorkflowLane.tsx`) drawing the dispatch queue as a left-to-right chain
of linked cards. Design decisions: positions are DERIVED, never stored, and
hierarchy-first — the column is the `depends_on` depth inside a connected
component (parallel branches of an N:1/1:N fan-in stack vertically in the
same column, like the graph view's layout transposed), while unrelated
components chain left-to-right by queue rank so a dependency-free queue stays
a flat conveyor (`desktop/src/shared/workflow.ts`, pure + bun-tested) — the
lane and the kanban can never drift, and the shared broker schema needs no
coordinates. A grid-assisted stack gesture (drop a card clearly above/below
another: dashed ghost slot) makes it a parallel sibling by adopting the
target's dependencies (sanitized, cycle-checked) — never offered between
dependency-related cards (they cannot run in parallel: the card slides
sideways, and an insertion that would wrong-side a link previews it live in
red, link and card borders alike); an expand button opens the lane as a
fullscreen foreground modal. Reorders commit through one new atomic broker route
(`POST /roadmap/reorder`: ids in order → queue 1..N in a transaction, others
unqueued, 500-id cap) instead of N racy upserts. Interactions: HTML5 drop from
the board (insertion caret), in-lane drag to reorder, a port to pull
`depends_on` links between cards (cycle-checked) or into the void (create-form
opens pre-wired; cancelling creates nothing), right-click to create at a slot,
red edges + click-for-why panel when the queue order breaks a dependency, a
warning badge for dependencies neither scheduled nor done, locked in_progress
cards shown as frozen chain heads, wheel/button zoom with auto-fit down to a
floor then a thin proportional scrollbar. The old flat queue list is replaced
by the lane (same dispatch button); the card context menu now toggles
queue/unqueue.

## desktop (experimental) — Greek glyph icon set, attention glow, button-style pass

Full iconography overhaul born from the CSS audit (DESIGN.md): the emoji rails
become a hand-drawn Greek-glyph SVG set (VS Code activity-bar contrast,
mythological metaphors — temple, theatre mask, labyrinth, caduceus…), extended
to generic action icons (`GLYPH_ACTIONS`), semantic badges (`GLYPH_BADGES`:
laurel lead, Themis scales judge, crossed xiphos battle, clepsydra waiting,
Olympic torch for the remote link) and coloured roadmap kind marks
(`GLYPH_KINDS`). The `.is-glowing` attention pulse gains a configurable colour
(Settings > Appearance, `--glow`, gold default). DESIGN.md + the `deck-design`
skill document the drawing rules; a generic `.btn` archetype closed the
unstyled-button gaps (Reload, worktree actions, offline-banner Dismiss + red
rail dot).

### To adjust with the operator (visual pass pending)
- **Mobile roadmap sheet actions**: provisional glyph choices — archive box
  (🗃), up-arrow "lift" (🎈), theatre mask for "assign to an agent" (🚀).
  Review on a real render and re-pick metaphors where they read poorly.
- Densest glyphs to eyeball at small sizes: caduceus, theatre mask, scales,
  oil lamp (roadmap "idea"), clepsydra.

## desktop (experimental) — Files & Git rail views (PLAN-git-explorer GX1–GX8)

Two new READ-ONLY navigation-rail views born from the "VSCode git view"
brainstorm. Design decisions: the Git view observes but never writes (no
stage/commit/branch, direct or delegated — the agents own the git workflow);
the file viewer ships without syntax highlighting in v1 (shiki/highlight.js
noted as the v2 candidates, PLAN-git-explorer.md phase D).

### Added
- **± Git view (GX1–GX3).** SCM-style promotion of the C13 DiffPanel: pick a
  worktree (attached-session badge) or a live session's dir on the left, read
  its diff on the right — branch-vs-main + uncommitted sections, clickable
  per-file numstat narrowing to a single file's diff (`collectFileDiff`, new
  `diff:collect-file` channel, tier 0), 10 s poll, the one-shot review agent
  button. Untracked files render through `git diff --no-index /dev/null`.
  Paths crossing the renderer/companion boundary are containment-checked
  (`isRepoRelative`).
- **📁 Files view (GX4–GX6).** Lazy read-only explorer + plain-text viewer
  (line-number gutter, 5 000-line render cap). New pure module
  `explorer-service.ts`: realpath containment (symlink escapes rejected),
  `.git` hidden, 512 KB read cap, NUL-sniff binary detection. The browsable
  roots (`explorer:roots/list/read`, tier 0) are re-validated main-side on
  every call: project dir + worktrees + live session cwds, nothing else.
- **Selection → assistant / roadmap (GX7–GX8).** Selecting code in the viewer
  offers "❓ Explain" (help assistant opens prefilled, the snippet travels as
  `code_selection` inside the app-composed SYSTEM snapshot — capped 20 KB,
  `sanitizeHelpSelection`, never on the command line) and "🗺 Create a task"
  (roadmap create form prefilled: kind debt, status planned, snippet quoted;
  saving stays an explicit operator action). Store seeds: `helpSeed` /
  `roadmapSeed`.
- **Security hardening (GX-SEC, from the branch's own security review).** The
  diff handlers (`diff:collect`, `diff:collect-file`, `diff:review`) now
  re-validate their `dir` argument against the same work-dir allow-set as the
  explorer (project dir + worktrees + session cwds), factored into one
  `workDirRoots`/`requireWorkDir` helper shared by both feature areas —
  closing an arbitrary-file-read the `git diff --no-index` content fallback
  could otherwise reach with an attacker-chosen `dir` (tier-0 channel,
  companion-reachable). The `--no-index` fallback is additionally gated on a
  realpath containment check (`realpathWithin`) so a committed symlink in a
  cloned repo cannot dump a file outside the tree.
- Docs: `interface.md` (rail table + two view sections), `DESKTOP.md`
  highlight, `PLAN-git-explorer.md` (status tracked per phase; phase D =
  highlighting, not started). Tests: `desktop-explorer.test.ts`, per-file
  diff + selection-sanitizer cases in `desktop-diff.test.ts` /
  `desktop-help.test.ts`.

## desktop (experimental) — reference documentation for the assistants

### Added
- **Reference documentation (`desktop/docs/`).** 14 markdown pages covering
  the whole app for the end user AND the built-in assistants: overview &
  concepts, interface tour, sessions, workspaces/templates, supervisor &
  team spawning, roadmap, browser/design mode, graph chats, communication
  (megaphone/inbox/journal), help assistant & digest, mobile companion, a
  full settings/configuration reference, and a troubleshooting FAQ. Shipped
  in packaged builds via `extraResources` (like `locales/`); integrity
  (index completeness + link resolution) is guarded by
  `tests/desktop-docs.test.ts`.
- **Help assistant grounding.** `buildHelpSystemPrompt` gains an
  app-computed `docsDir` pointer (`resolveDocsDir`: resourcesPath when
  packaged, app dir in dev) rendered as a "Reference documentation" section,
  and the claude utility adapter grants read access to that directory via
  `--add-dir` (`AdapterInput.addDir`, threaded through
  `runUtilityInference`). The read-only harness is unchanged; local HTTP
  endpoints keep answering from the snapshot alone.
- **Supervisor docs pointer.** `buildSupervisorSystemPrompt(docsDir?)`
  appends an app-generated paragraph pointing the supervisor at the same
  directory for "how does the app work / how do I configure it" questions.
  The role definition stays a code constant (C8 rule): only the PATH is
  app-computed, and omitting it yields the byte-identical previous anchor.

## desktop v0.13.0 (experimental) — supervisor team spawn (PLAN-team-spawn TS1–TS7)

The supervisor can now compose and spawn whole agent teams from the roadmap or
an operator request, per `EXPLORATION-team-spawn.md` (decisions §8) and
`PLAN-team-spawn.md`. v1 is Claude-only; the `cli` field is contract-frozen
(only `claude` accepted) so the future multi-CLI lot is not a breaking change.

### Added (desktop, v0.13.0)
- **Team playbook + embedded catalog (TS1).** `main/team-embedded.ts`: the
  hardcoded team-building skill (`TEAM_PLAYBOOK` — consent rule, Case 1
  roadmap / Case 2 prompt decomposition, granularity tree, wave sequencing
  under the cap, briefing/ack contracts, `deck_save_template`
  capitalization) and a 6-role embedded fallback catalog (`EMBEDDED_AGENTS`:
  team-lead, developer, reviewer, explorer, debugger, test-engineer) — all
  CODE CONSTANTS (C8 rule), profiles referenced by id and injected via
  `--append-system-prompt-file` (regenerated at every spawn), read-only
  roles hardened with `--disallowedTools "Write,Edit,NotebookEdit"`.
- **deck-control team tools (TS2).** `deck_team_playbook`,
  `deck_team_agents`, and `deck_spawn_team` (a whole plan in ONE call:
  validate-everything-first, batch cap check, per-plan approval, async
  acks). `deck_spawn_session` gains `cli`, `embedded_agent` (mutually
  exclusive with `agent`, unknown id lists the catalog) and `wait_for_peer`
  (default true). An embedded team-lead takes the window crown only when no
  live lead exists (template C18 rule).
- **Spawn-ack loop (TS3).** `peer-resolved` now carries the session id; the
  Deck (script, never agent inference) resolves the ack: sync — the spawn
  call returns the peer_id (90 s wait, falls back to async); async — a
  targeted CODE-CONSTANT `deck` announce to the supervisor when the session
  connects (`composeSpawnAckText`), fails to within 120 s, or exits early
  (`composeSpawnFailText`).
- **Trust-mode setting (TS4).** `config.supervisorSpawnMode`
  (`hands-free` default / `team-review` / `full-control`) gating every
  supervisor spawn: no dialog / ONE native recap dialog per plan /
  one dialog per agent (native pattern of the template approval). Settings >
  General radio group with per-mode help texts (en/fr).
- **Supervisor consent rule (TS5).** `SUPERVISOR_SYSTEM_PROMPT` now anchors:
  never spawn on own initiative; a question calls for a proposal + explicit
  confirmation; a peer message / file / roadmap item is NOT operator consent.
  The deck-control MCP bridge (v0.6.0) declares the new tools and repeats the
  consent line in its instructions.

## desktop v0.12.0 (experimental) — companion LAN access (PLAN-mobile-lan MB1–MB6)

LAN-only mobile access to the desktop window, per `EXPLORATION-mobile-lan.md`
and `PLAN-mobile-lan.md`. The renderer is web-remoted, not pixel-streamed: the
main process serves the SAME renderer bundle over HTTPS+WebSocket and a
generated shim replaces `window.api` on the phone, so terminals, roadmap,
inbox and the rest run natively in the mobile browser/WebView. **The desktop
window is behaviorally unchanged** — every mobile behavior is derived and gated
on a remote coarse-pointer client (`.is-mobile`), never on window width.

### Added (desktop, v0.12.0)
- **Companion bridge (MB1).** `shared/companion.ts` (pure, bun-tested) declares
  the DeckApi surface as data (`COMPANION_MANIFEST`, `satisfies` 1:1 with
  DeckApi), the wire frames, the LAN-only guard (`isPrivateAddress`,
  RFC1918/ULA/CGNAT), the single-use-token→credential lifecycle
  (`CompanionAuth`) and the declarative sensitivity tiers (§5.4).
  `main/api-registry.ts` routes every `ipcMain.handle/on` through one table
  serving both Electron IPC and the WS bridge, with `broadcast()` fanning
  state events to the window AND every client. `main/companion-server.ts`
  is the HTTPS+WS server (persistent self-signed cert, anti-bruteforce
  lockout, heartbeat). `renderer/src/remote-api.ts` is the WS `window.api`
  shim (reconnect, host-death watchdog, light/full channel).
- **Compagnon button + pairing (MB2).** A 📱 rail button (desktop only) opens
  a QR-code dialog (`CompanionDialog.tsx`); one-shot token bound to the app
  run, exchanged for a per-run credential; closing the app revokes everything
  (ephemeral session model, §5.5).
- **Mobile shell (MB3).** Bottom-tab nav (`MobileNav`), bottom sheets
  (`MobileSheet`), agents pager with session chips + xterm key bar
  (`MobileAgents`/`KeyBar`), `visualViewport` refit. Same stores/IPC, CSS
  gated on `.is-mobile`.
- **Mobile roadmap + floating basket (MB4).** `RoadmapList.tsx`: one column
  at a time (status tabs + counters), action sheet mirroring the desktop
  right-click menu, and the long-press→seize→detach floating basket
  (`shared/hold-gesture.ts`, bun-tested). Same five roadmap IPC calls.
- **Light background channel (MB5).** Backgrounded clients drop `pty:data`/
  `session:thinking`, keep the signal events; `bufferedAmount` backpressure
  guard on the terminal stream.
- **Android shell scaffold (MB6).** `mobile-shell/` — thin Capacitor shell
  (QR scan → WebView on the host URL), with the native TODOs (foreground
  service, biometric app lock + `FLAG_SECURE`, cert pinning) documented. Not
  built here (needs Android SDK); never bundled into the desktop package.

## core v0.9.0 + desktop v0.11.0 -- 2026-07-19

Error observability (PLAN-observabilite-erreurs O1-O6, plan retired into this
entry): the audit of invisible crashes found ad-hoc `console.error` everywhere,
no log file on either side, no process-level nets, and an activity journal
that evaporated at quit. Both sides now own bounded rolling logs, every layer
has a designated error sink (the "No silent errors" convention in CLAUDE.md +
the `error-reporting` skill), and the Deck surfaces failures deliberately:
journal for background errors, throttled toasts for direct actions, a
persistent red banner for the broker-down state. No Sentry/SaaS: everything
stays on the operator's machine (local-first decision).

### Added (core, v0.9.0)
- **Rolling file logger (O1).** `shared/logger.ts` (node-fs only, no deps):
  size-rotated `<name>.log` (5 MiB × `maxFiles=3`, boot trim, synchronous
  appends so an uncaughtException handler can flush a last line), console
  mirror for terminal runs, `coreLogDir()` resolving `<config dir>/logs`
  (override `CLAUDE_PEERS_LOG_DIR`). The broker writes `broker.log` — it
  previously spawned with stdout ignored and `unref()`, so once its spawner
  died its diagnostics went nowhere; `server.log` sits behind server.ts's
  existing `log()` helper (stdout untouched: it carries the MCP protocol).
- **Process-level nets + guarded timers (O2).** `uncaughtException`/
  `unhandledRejection` log-then-exit(1) in broker.ts and server.ts (Bun exits
  on unhandled rejections — now with a trace). The four broker maintenance
  timers (`cleanStalePeers`, `sweepInactivePeers`, `releaseStaleLocks`,
  `purgeOldMessages`) run through `guardedInterval`: they execute outside the
  HTTP handler's try/catch, so a transient SQLite error (BUSY, disk full) was
  the most likely invisible-crash vector; it now skips the iteration and logs.
- **Transactions on multi-statement sequences (O2).** `recordMessageTx`
  (message insert + activity refresh + heuristic ack) and `purgeDormantPeerTx`
  (FK-ordered deletes) — an abrupt broker death mid-sequence no longer leaves
  partial state. Handler 500s keep the stack in broker.log (clients only got
  the message). A malformed `config.json` is reported (path + parse error)
  before booting on defaults instead of being silently discarded;
  `pollFallback` notification failures log once per message.

### Added (desktop, v0.11.0)
- **main.log + central `reportError` (O3).** `src/main/log.ts`: rolling
  `main.log` under `app.getPath('logs')`; `reportError(scope, msg, err)` fans
  out to file + console (dev) + a new journal `error` kind, so the Journal
  view doubles as the operator's error console. The ~7 log-only catches of
  index.ts (announce, dispatch, auto-save, design endpoint…) and the silent
  persistence catches (config/session store, provider keys, worktree init)
  now route through it. The journal itself flushes to `journal-<date>.log`
  at quit (pruned after 7 days) instead of evaporating with the process.
- **Crash nets (O3/O4).** Main: `uncaughtException`/`unhandledRejection`
  log-and-continue once ready (live PTYs beat a crash), errorbox + exit
  before; `render-process-gone` journals and offers a reload;
  `child-process-gone` is logged. Renderer: `ErrorBoundary` at the root and
  around every top-level view — the views are siblings of one tree, so one
  view's render crash used to blank the whole window, terminals included;
  window-level `error`/`unhandledrejection` forward to main.log; `init()`
  failure shows a bilingual retry splash instead of spinning forever;
  preload `subscribe()` callbacks are guarded like `multiplex()` already was.
- **Broker-down banner + toast policy (O5).** `BrokerHealthTracker`
  (2-consecutive-failure hysteresis, fed by the operator-inbox poll) pushes
  `broker:status` to a persistent full-width red `StatusBanner` (outage time,
  last error, Retry forcing an immediate poll), self-dismissing on recovery —
  an outage is a state, not an event, so it is a banner and never toasts.
  `showToast` gains an `error` variant with raw-text support, throttled to
  one per key per 5 s, and is documented as reserved for direct user-action
  outcomes.
- **Guarded actions & hardened edges (O6).** Every mutating store action goes
  through `guarded()`: an IPC rejection logs + toasts instead of silently
  no-oping the click as an unhandled rejection. `pty.spawn` is wrapped (bad
  cwd / missing shell used to leave a pushed-but-never-broadcast zombie def;
  the tile now shows exited and Restart retries) and writes into a dead PTY
  are reported once per session. Operator-inbox batches whose disk write
  failed are re-queued for the next poll (the broker drain is destructive —
  that queue is the only remaining copy). Graph save/list/create/delete
  failures surface in the in-view notice; the embedded browser paints an
  in-frame error with Reload on `did-fail-load`/`render-process-gone`; a
  provider key that fails to decrypt (keychain change) is reported instead of
  masquerading as "no key stored".

## desktop v0.10.3 -- 2026-07-17

### Added (desktop, v0.10.3)
- **Graph conversations encrypted at rest (K8).** `graph-store.ts` accepts
  the safeStorage-backed `SecretCipher` (same injected surface as the C29
  provider keys / D8 scope secrets): the per-project graphs file becomes an
  `{ v, cipher: 'safeStorage', payload }` envelope instead of clear JSON.
  Legacy clear files keep loading and are re-encrypted on the first
  `graph:list` (`migrateGraphsAtRest`); when the OS keychain is unavailable
  (Linux without a keyring) the store falls back to clear text rather than
  breaking the feature. An undecryptable file (OS key changed) yields an
  empty list, never a crash. Deliberately NO server-side storage: the broker
  is shared-token + possibly remote, so operator conversations stay on the
  operator's machine (operator decision on top of D7).

## desktop v0.10.2 -- 2026-07-17

### Added (desktop, v0.10.2)
- **Priority quick-switch (K7).** The MoSCoW chip on each kanban card opens a
  styled dropdown (context-menu look, colored rows, ✓ on the current level)
  to change the priority without opening the detail modal. Metadata write:
  allowed even on locked cards (the broker guard only protects status/lock).

## desktop v0.10.1 -- 2026-07-17

Roadmap card context menu & direct assignment (K6).

### Added (desktop, v0.10.1)
- **Card context menu (K6).** Right-click on a kanban card: ✏️ Edit… (opens
  the edit modal; also reachable via a pencil button in the detail modal's
  header, which replaces the old Edit action button), ⏳ Add to dispatch
  queue, ▶ Process now…, 🗑 Delete (archives — the data model keeps deletion
  a reversible archive, same confirmation dialog). Entries grey out when the
  item is locked, closed or already queued. Reuses the generic `ContextMenu`.
- **Process now (K6).** A dialog lists the window's live agents (peer_id
  resolved, supervisor excluded, 👑 marks the lead): picking one sends the
  item as a TARGETED announce (`composeAssignText`, CODE CONSTANT — full item
  + take-it-now contract), moves it to in_progress (unqueued; the lock still
  arrives when the agent claims it) and journals the assignment
  (`assignRoadmapItem`, IPC `roadmap:assign`). The "＋ New agent on this
  item…" button falls through to the existing launch flow.

## core v0.8.0 + desktop v0.10.0 -- 2026-07-17

Roadmap kanban & agent work-lock (PLAN-ROADMAP-KANBAN K1-K5, plan retired
into this entry): the Roadmap view becomes a status-column kanban board, and
the broker learns to distinguish items *really being worked on* (locked by an
agent) from items merely queued as in_progress.

### Added (core, v0.8.0)
- **Agent work-lock (K2).** `roadmap_items` gains `locked`/`locked_by`/
  `locked_at` (plain-text peer_id snapshot, no FK — rides the existing `by`
  field of every upsert, zero extra round-trip). A non-`deck` author writing
  `status=in_progress` claims the lock; leaving in_progress (or archiving)
  releases it; an explicit `locked: true|false` upsert field overrides. While
  locked, status writes / lock claims by anyone but the owner or `deck` are
  refused with 409 (`force: true` bypasses); non-status writes (context
  enrichment, tags) stay open to everyone. The `roadmap_*` MCP tool
  descriptions and channel instructions carry the contract ("in_progress =
  actually working, planned = releases"), and item renderings show `🔒 owner`.
- **Stale-lock sweep (K2).** `releaseStaleLocks` (every
  `CLAUDE_PEERS_LOCK_SWEEP_SEC=60`) unlocks and drops an item back to
  `planned` (attribution `lock-sweep`) when the item saw no write for
  `CLAUDE_PEERS_LOCK_TTL_SEC=21600`, or when no active peer carries the
  owner's peer_id for the item's project and the lock is older than
  `CLAUDE_PEERS_LOCK_GRACE_SEC=600`.
- **Deck announcements harden the no-reply contract (K4).**
  `DECK_NO_REPLY_NOTE` now also forbids messaging *any other peer* about an
  announcement (agents used to greet newcomers via send_message).

### Added (desktop, v0.10.0)
- **Kanban board (K1).** `RoadmapView.tsx` reworked: one column per status
  (idea/planned/in_progress/done, + archived behind the existing toggle),
  MoSCoW priority as a colored chip + in-column sort, native HTML5 drag &
  drop between columns. Dropping on done asks for confirmation (the item
  will no longer be picked up); a locked card is greyed, dash-bordered,
  non-draggable and badged `🔒 locked_by`. The dispatch-queue strip and the
  create/edit form (now a modal) are unchanged in behavior.
- **Detail modal (K5).** Clicking a card opens a Trello-style foreground
  modal (`RoadmapItemModal.tsx`): badge grid, titled sections for
  description / rationale / context rendered as markdown, dependencies,
  authorship, and the action bar. `markdown.ts` is an injection-safe
  tokenizer (token tree only, React escapes every text node; supported:
  headings, lists, fences, inline code/bold/italic, links surfaced but never
  navigated) — no markdown dependency added.
- **Operator stop (K3).** ⏹ Stop on a locked item, after confirmation,
  sends a CODE-CONSTANT notice (`composeStopText`, C8 rule) through the live
  supervisor when there is one (targeted announce; the supervisor relays,
  verifies and reports back through the operator inbox) or broadcasts to the
  group, then unlocks the item back to `planned` (`stopRoadmapItem`,
  IPC `roadmap:stop`). Toasts distinguish supervisor / broadcast / no-peer.
- **Idle-lock watcher (K2).** `SessionService` tracks `lastOutputAt` per
  PTY; a minute-tick watcher releases locks owned by local tiles whose
  terminal printed nothing for 2 h. Complements the broker sweep (the
  heartbeat keeps an idle session `active`), and only for sessions this
  Deck can observe.
- **Join announces are explicitly no-reply (K4).** `composeJoinAnnounce`
  appends "do NOT reply, do NOT greet or message the new peer" — the
  broker-side deck note only forbade replying to `deck`.

## docs -- 2026-07-16

- **Working plans retired.** `PLAN-v0.4.md`, `PLAN-context-et-snippets.md`,
  `EXPLORATION-roadmap-et-auto-relance.md` and `EXPLORATION-graph-chat.md`
  (all chantiers shipped) are deleted; their per-batch narratives live in
  this file, and the still-open deferred items (graph digest/artefact nodes,
  graph export + per-node cost, OTEL consumption tracking, GitHub Issues
  sync, the C23-C29 manual UI validation) moved to `roadmap-seed-v0.9.json`
  (`bun cli.ts roadmap-import roadmap-seed-v0.9.json`).
- **CLAUDE.md rewritten for a public repo.** The version-history narrative is
  replaced by a current-state overview (core architecture, protocol
  invariants, desktop overview, checks & conventions); pointers to the
  deleted plans and machine-specific examples are gone. `Cxx` ids in code
  comments now resolve through this changelog.

## desktop v0.9.0 -- 2026-07-16

Graph chat & battle mode (EXPLORATION-graph-chat C23-C27): a canvas view
where every exchange is a node — branch "what if" explorations anywhere,
cross N branches into one prompt node, fan a prompt out to several headless
CLIs, and let a judge node arbitrate a battle.

### Added (desktop, v0.9.0)
- **Graph data model + engine (C23).** `shared/graph.ts`: DAG of typed nodes
  (user / assistant / judge, N parents for cross/merge nodes), pure ops
  (ancestors, cycle refusal, deterministic topological linearization,
  three-way-style `mergePartition` — common trunk + per-branch deltas) and
  shape validation. Per-project persistence (`graph-store.ts`) under the app
  state dir, keyed by the deck project_key (stable across worktrees/clones).
- **Headless CLI adapters (C24).** `model-adapters.ts` generalizes the C9
  skeleton: `claude -p` (context via `--append-system-prompt-file`,
  `--strict-mcp-config` + `--disallowedTools`), `codex exec --sandbox
  read-only` and `gemini` (context file fed through stdin, POSIX redirection
  or PowerShell `Get-Content -Raw` pipe). The compiled context always travels
  by FILE (never the command line); `model` strings are sanitized; `runHelp`
  gains an optional timeout (300 s for inference).
- **Context compilation + inference (C25).** `graph-engine.ts`: three CODE
  CONSTANT system prompts (linear chat, merge, judge — C8 rule). 0-1 parents
  → labeled linear transcript; 2+ parents → documentary merge rendering
  (trunk once + labeled divergent branch sections, never a fake linear
  conversation). 60k-char budget with explicit elision markers. Fan-out via
  `Promise.allSettled` (a failed target yields an error node, never blocks
  siblings). IPC `graph:list/create/delete/save/compile/infer` + journal kind
  `graph`.
- **Graph view (C26).** New 🕸 rail view: per-project graph list,
  dependency-free canvas (SVG bezier edges + positioned cards, pan/zoom/drag,
  manual layout), multi-selection, reply / node-from-selection (cross) /
  connect-parent (cycles refused) / leaf-only delete, and a context inspector
  showing exactly what will be sent. i18n en/fr.
- **Battle mode (C27).** Check several CLIs on a prompt node: one answer node
  per target; with battle ON and ≥2 successful answers, a 🏆 judge node
  (default claude/sonnet, configurable) compares the ANONYMIZED answers,
  picks the strongest and produces the merged answer — the model mapping is
  revealed in a legend after the verdict. Degrades gracefully to no judge
  with <2 answers.
- **Unified model picker (C29).** One `ModelPicker` shared by the graph
  fan-out (multi-select chips) and the agents' advanced create menu (single,
  Anthropic ∪ launch-config models): expandable provider sections
  (Anthropic / OpenAI / Gemini + local endpoints), a separator, and
  star-pinned favorites persisted in the app config (`providerId:modelId`
  keys, pin order). Frontier providers only appear when their CLI is
  detected on the machine (login-shell `command -v` / `Get-Command`, cached,
  re-detect button in Settings); frontier model lists are CURATED IN CODE
  (`FRONTIER_CATALOG`, the one constant to bump — the OAuth CLIs expose no
  dynamic listing) while local OpenAI-compatible endpoints (Ollama, LiteLLM,
  vLLM…) are discovered dynamically (`/v1/models`, Ollama `/api/tags`
  fallback). New Settings > Models section manages local endpoints (name,
  base URL, optional API key, discovered-model count). Local targets run as
  a new `cli:'local'` through a direct `/v1/chat/completions` call from the
  main process — the API key never reaches the renderer or a command line.
- **Provider API keys encrypted at rest (C29/D12).** Local-provider Bearer
  tokens go through Electron `safeStorage` (`provider-secrets.ts`, same
  cipher surface as scope secrets): the renderer only ever sends a transient
  `apiKey` when the operator (re)types one ('' = forget, ⊘ button) and only
  ever receives a `hasKey` marker — `config:get/set/changed` are sanitized;
  the config file stores `enc:<base64>` blobs (explicit `plain:` fallback
  when no OS keyring), decrypted in main memory only at discovery/inference
  time. A corrupt blob (OS key change) degrades to "no key stored".

## v0.7.0 -- 2026-07-16

The "briefed agents" batch (PLAN-context-et-snippets C20-C22): roadmap items
carry an implementation briefing that travels to the agent, a magic-wand
assistant drafts it for manual creations, and recurring operator prompts
become reusable snippets.

### Added (core: broker / server, v0.7.0)
- **Roadmap `context` field (C20).** `roadmap_items.context TEXT NOT NULL
  DEFAULT ''` (idempotent migration): the implementation briefing for the
  agent that will pick the item up later — objective, constraints/scope
  boundaries, file pointers, acceptance criteria, decisions already made
  (description = what, rationale = why, context = how/where). Settable
  through `/roadmap/upsert` (partial-patch semantics), preserved by
  archive and export/import. `roadmap_add`/`roadmap_update` expose it,
  `roadmap_get` shows it, and the MCP instructions ask agents to ALWAYS
  fill it (the agent that discovers a bug writes the briefing for the
  future agent that fixes it).

### Added (desktop, v0.8.0)
- **Context in the Deck (C20).** Item editor textarea with a
  semi-structured placeholder (Objective / Constraints / Pointers /
  Acceptance criteria), detail panel block, and the briefing travels as a
  delimited data field in both agent hand-offs: the C15 queue dispatch to
  the team-lead (`Context (operator briefing): ...`) and the "Launch an
  agent on this item" prompt. The plan-import agent (C7) is instructed to
  fill `context` for every item it creates, quoting the plan's specifics.
  The help-assistant snapshot includes it (truncated).
- **Context wand (C21).** 🪄 button on the editor's context field: one
  throwaway read-only `claude -p` (pinned haiku, same locked harness as
  the help assistant — code-constant system prompt, `--strict-mcp-config`,
  `--disallowedTools`) drafts the briefing grounded in the project files
  (Read/Grep/Glob), preserving the operator's draft decisions. The result
  only fills the textarea — nothing is saved until Save.
- **Snippets (C22).** Reusable prompts as one `.md` file each, global
  (`<globalConfigDir>/snippets`) or project
  (`<projectDir>/.claude/claude-peers/snippets`, shadows global on a name
  collision, shareable via git). New ⚡ tile button opens a menu that
  pastes the snippet into Claude Code's input field through xterm's
  bracketed-paste path — **fill-not-send**, never auto-submitted — plus a
  manage dialog (create / edit / rename / change scope / delete).

### Fixed
- `tests/desktop-template-store.test.ts` still asserted the pre-rename
  `claude-peers-desk` global dir (stale since the v0.7.0 desktop rename).
- `desktop/package-lock.json` re-synced with the `kory` bin alias.

## v0.6.0 -- 2026-07-15

The "AI orchestrator" batch (PLAN C6-C19): the Deck grows from a session
container into a cockpit for a small agent team — a designated team-lead, an
operator inbox, diff review, an activity journal, a dispatch queue, git
checkpoints, a resume digest, a template composer, and two security gates.

### Added (core: broker / server)
- **Targeted announce (C10).** `POST /announce` accepts `to_peer_id` to
  deliver a Deck message to ONE active peer of the group (the team-lead
  notification path); 404 when the target is missing/dormant. Same reserved
  `deck` sender and no-reply semantics.
- **Operator inbox (C12).** New reserved sentinel `__operator__`/`operator`
  (dormant, never listed, never purged; `set_id` refuses the name).
  `send_message` to `operator` parks the message on the sentinel in the
  sender's group; new `POST /operator-inbox` (TOFU group auth) drains and
  marks them delivered. `server.ts` MCP instructions present 'operator' as
  the human in front of the Deck (questions, results, blockers).
- **Roadmap dispatch queue (C15).** `roadmap_items.queue INTEGER NULL`
  (idempotent migration): 1-based dispatch-queue position, settable through
  `/roadmap/upsert` (positive integer or null), preserved by export/import.

### Added (desktop, v0.6.0)
- **Worktrees view (C6)** in the rail: every worktree with branch, dirty
  count, last commit and the attached Deck session; orphans can be resumed
  into a new session or removed (never forced, branch kept).
- **Plan import (C7).** "Import a plan" in the Roadmap view: a file picker
  plus a ONE-SHOT agent (code-constant prompt) that converts the plan into
  deduplicated roadmap items, then exits.
- **Team-lead (C10).** One 👑 per window (`SessionDef.lead`, uniqueness
  enforced, captured in workspaces/templates): create-menu checkbox
  (suggested by the configurable `leadPattern`), right-click designation,
  and `announceToLead` targeted notices.
- **"Needs you" detection (C11).** `attention.ts` spots Claude Code waiting
  screens (permission chooser, trust prompt) in the PTY stream: ⏸ badge in
  the sidebar/tile plus a clickable system notification (toggle
  `notifyAttention`).
- **Operator inbox (C12).** 10 s drain of `/operator-inbox`, per-batch
  system notification, ✉ rail button with unread bubble and a read-only
  panel (replies go through the existing megaphone).
- **Diff / review (C13).** `diff-service.ts` collects uncommitted changes
  plus branch-vs-main commits (worktrees, merge-base); DiffPanel from the
  Worktrees view or a session's right-click; "Have an agent review this"
  spawns a one-shot reviewer that reports to the team-lead via
  `send_message` when one is live.
- **Activity journal (C14).** In-memory ring buffer (500 entries) narrating
  spawns/exits, quota episodes, attention screens, worktree operations,
  announces, dispatches, reviews and checkpoints; filterable 📜 rail view
  with plain-text export.
- **Dispatch queue (C15).** Roadmap items can be queued (⏳ #n) and sent to
  the team-lead one by one (full item + status contract, code-constant
  message); when a dispatched item turns `done`, the next queued one is
  auto-dispatched (20 s watcher). Button greyed with an explanation while
  no lead is designated.
- **Git checkpoints (C16).** Before an agent spawns into a DIRTY tree:
  `git stash create` anchored under `refs/claude-peers/checkpoint-<ts>` (no
  history/working-tree pollution), journal entry with the sha and the
  `git stash apply` restore command, 7-day purge. Fresh worktrees skip it.
- **Resume digest (C17).** 📋 button in the help popup: one read-only
  `claude -p` briefing (C9 harness) grounded in the app snapshot plus
  configured sources (files/globs + commands). Sources are read from the
  GLOBAL config only (`digest.sources`, `digest.perProject[project_key]`) —
  never from a project config, which would mean arbitrary command execution
  on clone; commands still run with cwd = projectDir.
- **Template composer (C18).** Create/edit/duplicate templates WITHOUT
  spawning (manage mode of the template picker): per-entry advanced fields
  (agent, model, effort, args, initial prompt, fresh-worktree branch,
  announce, colour) and a single-lead crown; hierarchical rendering (lead
  top-center). Applying routes through the worktree-aware path, and the
  template's lead only becomes the window's when none exists yet.

### Security
- **Project launchCommand gate (C19).** A `launchCommand` carried by the
  repo's `.claude/claude-peers/config.json` no longer runs silently: a
  first-use warning dialog shows the command; approval stores its sha256
  per project_key in the app state (a changed command asks again), refusal
  falls back to the global command and persists nothing. Journal entry
  either way.
- The C8 code-constant rule extends to every new agent prompt (plan import,
  reviewer, dispatch message, digest, help) — none is operator- or
  repo-configurable.

## v0.5.0 (desktop) -- 2026-07-14

### Added
- **Supervisor session (PLAN C5).** A new **Home** rail view hosts a full-width
  Claude Code session that PILOTS the Deck instead of coding: it reads the
  repo, consults the shared roadmap, spawns briefed agent tiles and coordinates
  them through the existing peers messaging. Spawned lazily on the first Home
  visit (manual start button after an intentional close). Its role definition
  is **locked in the application code**: a system-prompt anchor
  (`--append-system-prompt-file`, re-passed on resume) regenerated from a code
  constant at every spawn (a tampered file is overwritten) plus a short C2
  kickoff prompt -- deliberately NOT operator- or repo-configurable (no
  `supervisor.md`, no agent profile), so a cloned repository can never
  silently repurpose the session that pilots the app.
- **deck-control bridge.** The main process starts a loopback HTTP control
  endpoint (random port + per-launch Bearer token, `deck-control.ts`) and the
  supervisor is the ONLY session launched with a generated `--mcp-config`
  pointing at a dependency-free MCP stdio server
  (`desktop/mcp/deck-control-mcp.ts`, built to `deck-plugin/mcp/*.mjs`, run by
  the Electron binary as Node). 14 tools: `deck_list_agents/models/presets`,
  `deck_spawn_session` (agent/model/effort/prompt/worktree_branch/announce),
  `deck_list_sessions`, `deck_restart_session`, `deck_close_session`,
  `deck_create_worktree`, `deck_list_worktrees`, `deck_remove_worktree`,
  `deck_list_templates`, `deck_apply_template` (append-only),
  `deck_save_template`, `deck_announce`.
- **Guardrails.** Destructive tools (close session, remove worktree) only work
  on objects the supervisor itself created; template application never
  replaces/closes existing tiles; live sessions are capped at 8 on
  `deck_spawn_session`; the control token never touches the repo, project
  config or normal sessions. `--mcp-config` is re-passed on resume (like
  `--effort`), and the supervisor is excluded from workspace/template capture
  (its token only lives for the current app launch).
  Tests: `tests/desktop-deck-control.test.ts` (dispatch, auth, guards, and an
  end-to-end MCP stdio round-trip against a live control endpoint).
- **Floating "?" help assistant (PLAN C9).** A floating button (all views)
  opens a chat popup where each question runs a throwaway `claude -p` with an
  app-generated system prompt: the code-constant role (C8 rule) plus the
  active view and a JSON snapshot of what it shows (roadmap items, session
  list). The assistant is TECHNICALLY read-only, not just prompt-constrained:
  `--strict-mcp-config` loads zero MCP servers and `--disallowedTools` denies
  every mutating tool (Read/Grep/Glob stay, so answers can be grounded in the
  repo). Popup continuity replays the last 4 exchanges; a start marker strips
  login-profile noise from the captured output. Options in Settings > General
  and via right-click on the button: hide it, pick the model (default
  `haiku`). New `desktop/src/main/help-assistant.ts` +
  `tests/desktop-help.test.ts`.

## v0.4.0 -- 2026-07-14

### Added
- **Shared per-project roadmap (broker, C3-M1).** New `roadmap_items` table in
  the broker SQLite DB and three routes: `POST /roadmap/list` (filters
  kind/status/priority/tag, archived hidden by default), `POST /roadmap/upsert`
  (create with defaults or partial patch; a status change away from `archived`
  restores the item) and `POST /roadmap/archive` (reversible soft delete via
  `deleted_at`). Items are scoped by `project_key` (normalized git remote), NOT
  by group, and carry no FK to peers/groups — `created_by`/`updated_by` are
  plain-text peer_id snapshots — so their lifecycle is fully independent of
  sessions: no cleanup timer touches the table (`tests/broker-roadmap.test.ts`).
- **Roadmap MCP tools (C3-M2).** `server.ts` exposes `roadmap_list` (MoSCoW-
  grouped overview), `roadmap_get`, `roadmap_add` (only title required),
  `roadmap_update` (partial patch) and `roadmap_archive`. Ids accept unique
  8-char prefixes. Author stamps use the session's peer_id automatically;
  repos without a git remote fall back to a stable `local:<hash>` project key.
  The MCP instructions now tell agents to consult the roadmap at task start,
  record discovered bugs/debt, and keep item statuses current.
- **Deck roadmap view (C3-M3).** New navigation rail (Agents | Roadmap) on the
  left of the window; the agents view stays mounted (PTYs/xterm alive) while
  the roadmap is shown. The roadmap view groups items by MoSCoW priority with
  value/effort/status badges and tags, filters by kind, optional archived
  display, a detail panel and full operator CRUD (`created_by='deck'`); it
  polls the broker every 5 s while visible so agent writes appear live. Main
  process `roadmap-service.ts` mirrors server.ts's project-key resolution
  (normalized git remote, else the same `local:<hash>` fallback) so the Deck
  and its agents always see the same roadmap (`tests/desktop-roadmap-service.test.ts`).
- **Launch an agent on an item (C3-M4).** The item detail panel can spawn a
  session pre-filled with a composed initial prompt (uses the C2 positional
  prompt) and a join announcement; the item is flagged `in_progress` at spawn
  and the agent is instructed to keep its status current via the roadmap tools.
- **Roadmap export/import (C3-M4).** `GET /roadmap/export?project_key=` returns
  a versionable JSON snapshot (archived included); `POST /roadmap/import`
  bulk-imports it preserving ids, statuses, authors and timestamps (re-keying
  to a target project supported). New CLI commands `bun cli.ts roadmap-export`
  / `roadmap-import` (the local -> central broker migration path). The CLI now
  sends the configured Bearer token on all requests.
- **Worktree sessions (C4).** The advanced create menu takes a worktree branch
  name: the Deck runs `git worktree add <projectDir>/.worktrees/<name> -b
  <branch>` and spawns the session inside it, so parallel agents on the same
  repo never step on each other (one dir + one branch each; the roadmap stays
  shared since `project_key` derives from the remote, identical across
  worktrees). The sidebar row shows a `⎇ branch` badge; closing the tile
  offers (never forces) to remove the worktree — the branch and its commits
  are always kept, and git's dirty-tree refusal is surfaced, not overridden.
  Optional `worktreeInit` command in the launch config (e.g. `bun install`)
  runs in the background inside each fresh worktree. New
  `desktop/src/main/worktree-service.ts` + `tests/desktop-worktree.test.ts`.

## v0.3.5 (desktop) -- 2026-07-14

### Added
- **Quota auto-resume (opt-in).** When a tile hits Claude's usage limit, the
  Deck now detects the rate-limit screen in the PTY stream (rolling
  ANSI-stripped buffer; old "limit reached ∙ resets 2pm", new "You've hit your
  limit · resets 10pm (TZ)" and "resets Nm" formats, plus conservative
  fallbacks), parses the printed reset time (local clock; >1h past rolls to
  tomorrow; unknown time retries every 15 min), and once it passes injects
  `Escape` → `continue` → `Enter` — one shot per episode, exactly what a human
  would type. Off by default: global toggle in Settings > General
  (`autoResumeQuota`), overridable per session from the sidebar right-click
  menu (`SessionDef.autoResume`). The tile/sidebar dot turns orange while
  limited, with an "auto-resume at HH:MM" badge and a toast on injection
  (`session:quota` IPC event). New `desktop/src/main/quota.ts` +
  `tests/desktop-quota.test.ts` (PLAN-v0.4 C1).
- **Initial prompt at spawn.** A session can now be created with a prompt that
  is submitted to Claude as its positional argument on the fresh launch —
  never re-played on resume (`--resume` restores the conversation). New
  "Initial prompt" field in the advanced create menu; launch presets'
  `prompt` field (declared since M5, previously unwired) now pre-fills it.
  Quoting is platform-aware (POSIX `'\''` vs PowerShell `''`), covered in
  `tests/desktop-launch.test.ts`. Groundwork for roadmap→agent and the
  supervisor (PLAN-v0.4 C2).

## v0.3.4 -- 2026-06-03

### Added
- **Deck outbound announcements (`POST /announce`).** The desktop Deck can now
  broadcast one-way, fire-and-forget system messages to every active peer in a
  group: an automatic join announcement (with the newcomer's `peer_id` and its
  agent/model/effort) when a session's peer_id resolves, and free-text operator
  messages from a sidebar message bar (Send button). Both go through a single
  `/announce` endpoint.
- **Reserved system sender.** Announcements are stored from a non-routable
  sentinel (`from_token = '__deck__'`, `from_peer_id = 'deck'`), backed by one
  permanently-dormant reserved peer row so the `messages.from_token` FK resolves.
  The reserved row never appears in `list_peers`/`group-stats` and is exempt from
  the dormant TTL purge.
- **No-reply guarantee.** `server.ts` renders any `from_peer_id == 'deck'` message
  with an English "informational only -- do not reply" framing (WS push, fallback
  poll and `check_messages`), neutralising the channel's default reply nudge.
  Replies are also impossible: `send_message` toward `deck` finds no active
  target. `set_id` refuses the reserved names `deck` / `system`.

## v0.3.2.1 -- 2026-05-16

### Fixed
- **Broker crash-loop on dormant-peer purge (FK violation).** `cleanStalePeers`
  and `handleUnregister` deleted a peer row without first clearing the rows in
  `messages` that referenced it via `from_token`. Both `messages.from_token`
  and `messages.to_token` are FKs to `peers.instance_token`, so any peer that
  had sent at least one message would crash the `DELETE FROM peers` with
  `SQLiteError: FOREIGN KEY constraint failed` (errno 787). On a long-running
  broker this surfaced as a restart loop once the first dormant-with-history
  peer hit the TTL cutoff. Both DELETE paths now run
  `DELETE FROM messages WHERE from_token = ? OR to_token = ?` before deleting
  the peer (previously only `to_token = ? AND delivered = 0` was cleared, which
  covered neither `from_token` nor delivered receive-side history).
- Semantic change to be aware of: a purged peer's message history is now
  removed in full (both sent and received, regardless of `delivered`). This is
  required by the FK and is consistent with the v0.3.x model where messages
  have no lifetime independent of their peers.
- Regression covered by `tests/broker-fk-cleanup.test.ts` (sender purge via
  TTL, and direct `/unregister` of a peer with sent messages).

## v0.3.2 -- 2026-05-15

### Added
- New opt-in env var `CLAUDE_PEERS_STATUS_LINE_CACHE` (default off). When set to
  `1`/`true`/`yes`/`on` (case-insensitive), `server.ts` writes the active
  `peer_id` to `$HOME/.claude/peers/peer-id-<cwd_key>.txt` after every
  successful `/register` (initial and on group switch). This is the file
  consumed by status-line scripts such as `~/.claude/status-line.sh:get_peer_id`.
  Off by default because the cache is only useful for users who wire a
  status-line and most users will not want `server.ts` to litter `$HOME`.
- New module `shared/peer-cache.ts` exposing `computeCwdKey()`,
  `isPeerIdCacheEnabled()`, and `writePeerIdCache()`. The key derivation matches
  the bash logic exactly: non-alphanumeric (and non-hyphen) chars replaced with
  `_`, last 40 chars kept, with an explicit offset to avoid the MSYS2 bash 5.2
  `${str: -N}` quirk. Best-effort writes (FS failures do not break `/register`).

### Removed
- **SessionEnd bash hook** (`hook-session-end-peers.sh`), its installer
  (`install-hook.ts` + `--uninstall` flag), and the now-unused broker endpoint
  `POST /disconnect-by-cli-pid` (and its `DisconnectByCliPidRequest`/`Response`
  types). Rationale: the hook never fired at a useful moment on Windows
  (Claude Code detaches the hook so `$PPID = 1`, never matched a real peer),
  and on Linux/macOS it only duplicated the work that `server.ts`'s
  SIGTERM/stdin EOF handler already does. The broker-side safety nets
  (`cleanStalePeers` every 30s for same-host PIDs, `sweepInactivePeers` every
  60s for stale heartbeats >120s) cover every realistic crash scenario. Worst
  case for a crashed cross-host peer: ~180s before it flips dormant.
- Test files dropped along with the hook: `tests/hook-session-end.test.ts`,
  `tests/install-hook.test.ts`, `tests/broker-list-peers-by-host.test.ts` (the
  latter was a v0.3.2-internal experiment that never shipped to main).

### Note on upgrade

If a previous v0.3.1 install registered the hook in your `~/.claude/settings.json`
under `hooks.SessionEnd`, that entry now points at a non-existent script and
will be a silent no-op. To clean it up, remove the entry and delete
`~/.claude/hooks/session-end-peers.sh` (or `hook-session-end-peers.sh` depending
on how it was installed). No data loss, no DB migration.

### Fixed
- **Bug C -- status-line `peer_id` segment empty or stale.** Previously,
  `~/.claude/status-line.sh:get_peer_id` read a cache that only the deleted v0.2
  SSH client (`client.ts`) used to write, so on v0.3+ status-lines either showed
  nothing (fresh cwd) or a stale id from a v0.2 session. Users who set
  `CLAUDE_PEERS_STATUS_LINE_CACHE=1` now get a fresh cache file refreshed on
  every `/register`.

## v0.3.1 -- 2026-05-14

### Added
- Auto-disconnect on Claude Code session end via three mechanisms:
  - SessionEnd hook (`hook-session-end-peers.sh`) POSTs `/disconnect-by-cli-pid`.
  - `server.ts` self-shutdown on stdin EOF.
  - Broker `sweepInactivePeers` safety net (60s timer, 120s stale threshold).
- New env vars: `CLAUDE_PEERS_ACTIVE_STALE_SEC` (default 120), `CLAUDE_PEERS_DORMANT_SWEEP_SEC` (default 60).
- New broker endpoint: `POST /disconnect-by-cli-pid`.
- New DB column: `peers.claude_cli_pid INTEGER`.
- Installer: `bun install-hook.ts` (idempotent, supports `--uninstall`).

### Changed
- Hook script is now bash (.sh), installed under `~/.claude/hooks/session-end-peers.sh`
  for consistency with other Claude Code hooks (kleos pattern). The installer
  (`bun install-hook.ts`) copies it from the repo to the user's hooks directory and
  registers a `bash <path>` command in settings.json.

### Removed
- SSH deployment mode and `client.ts` (use HTTP mode or local-only).
- `CLAUDE_PEERS_REMOTE` env var.
- `tests/server-handshake.test.ts`, `tests/client-config.test.ts`.

### Fixed
- Windows: `server.ts` `BROKER_SCRIPT` path resolution via `fileURLToPath` (local-only mode now works on Windows).
- Cross-host peers no longer flap to `dormant`: `cleanStalePeers` now restricts its `process.kill(pid, 0)` liveness check to peers whose `host` matches the broker's `os.hostname()`. Foreign peers (HTTP mode, client on another machine) are reaped via the heartbeat sweep instead. Previously, all remote peers were flipped dormant on every 30s tick because their Windows/macOS PIDs were probed against the Linux broker's process table.
- New env var `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` (default 30) to tune the `cleanStalePeers` interval.
