---
name: add-deck-view
description: Full-stack file chain for adding a navigation-rail VIEW and/or a DeckApi IPC channel to the desktop app (desktop/, no broker involved) — which files to touch, in which order, the compile-time gates that catch omissions, the companion/security tier decision, and the i18n/locale parity rule. Use when adding a rail view, a window.api/IPC method backed by a main-process service, or any renderer↔main desktop feature. For an agent→broker→Deck feature, use add-broker-feature instead.
---

# Adding a desktop rail view and/or IPC channel (renderer ↔ main)

Purely-desktop features (a main-process service exposed to the renderer, a new
rail view) follow a fixed file chain that is NOT covered by
`add-broker-feature` (that one is for agent→broker→Deck). Several layers have
COMPILE-TIME gates that fail the typecheck if you miss them — lean on them.
Reference implementation: the **Git / Files views (GX1–GX9 lot)**
— grep `explorer` / `collectFileDiff` / `'files'` / `'git'` to see the whole
chain end to end.

Two independent sub-chains — do the one(s) you need:

## A. New IPC channel (`window.api.foo()` backed by a main service)

1. **Main service — `desktop/src/main/<feature>-service.ts`.** Node builtins
   only (no electron, no `@shared` alias) so it is bun-testable on a throwaway
   fixture. Imitate `diff-service.ts` / `explorer-service.ts`. Pure logic that
   the renderer ALSO needs goes to `desktop/src/shared/` instead (imitate
   `shared/code-selection.ts`). Test: `tests/desktop-<feature>.test.ts`.
2. **IPC handler — `desktop/src/main/ipc.ts`.** `regHandle('domain:verb', …)`.
   **SECURITY (the "third hostile input", CLAUDE.md):** if an argument becomes
   a filesystem path / git target / spawned cwd, re-validate it MAIN-side on
   every call against the work-dir allow-set (`requireWorkDir` / `workDirRoots`;
   realpath containment on the leaf via `resolveWithin`/`realpathWithin`). The
   companion tier is a declaration, not a gate. Never trust the renderer's
   `dir`. **No silent errors:** a swallowed catch needs a `reportError(...)`
   trace unless the fallback is truly equivalent.
3. **DeckApi type — `desktop/src/shared/types.ts`.** Add the method signature
   to the `DeckApi` interface (and any `on<Event>` subscription, returning an
   unsubscribe fn). Renderer-facing payload types live here too.
4. **Companion manifest — `desktop/src/shared/companion.ts`.** THREE edits, all
   gated:
   - `COMPANION_MANIFEST`: `{ kind: 'invoke'|'send'|'event', channel }`. A
     `satisfies Record<keyof DeckApi, …>` clause makes a MISSING entry a
     compile error — this is why step 3 and this one can't drift.
   - `CHANNEL_TIERS`: every invoke/send channel needs a tier (0 read · 1
     interact · 2 execute/structure · 3 trust-changing) — a test enforces
     totality. Pick the tier from what the channel can DO, not what it's for.
   - `REMOTE_BLOCKED_CHANNELS`: add it here IF a paired phone must never call
     it (native dialogs, captures, host-only/trust-changing actions). A pure
     read is usually fine to leave reachable.
   The remote WebSocket shim (`renderer/src/remote-api.ts`) is generated FROM
   the manifest — nothing to touch there.
5. **Preload bridge — `desktop/src/preload/index.ts`.** One
   `ipcRenderer.invoke('domain:verb', …)` per method, one `subscribe('channel',
   cb)` per event. The web typecheck fails if preload and `DeckApi` drift.
6. **Renderer store (if the feature carries state) — `store.ts`.** State field
   + default, actions wrapped in `guarded(...)`, cross-view navigation via
   store state consumed by an effect (imitate `helpSeed`/`roadmapSeed` or
   `graphFocus`/`clearGraphFocus`). One-shot seeds: set the seed AND flip the
   view in the same `set(...)` so the target view mounts with the seed present.

**Need a TERMINAL that is not a session tile** (a login flow, a build log)?
Use a **utility PTY**: `service.spawnUtility(id, cwd, opts)` /
`killUtility(id)` (`session-service.ts`) spawns on the shared `PtyManager`, so
`pty:input`/`pty:resize`/`pty:data`/`pty:exit` route for free — nothing to add
to the bridge — but the id never enters `defs`, so `sessions:list`,
`hasLiveSessions()` and workspace capture ignore it. The id must be a
CODE CONSTANT exported from `shared/types.ts` (never a renderer-supplied
string reaching a kill), and its stop channel takes no argument. Render it
with `SandboxTerminal.tsx` (or `DockTerminal` in `BrowserView.tsx`): plain
xterm, no `registerTerminal` — that registry belongs to real session tiles.

## B. New navigation-rail view

1. **`DeckView` union — `desktop/src/shared/types.ts`.** Add the id.
2. **`desktop/src/renderer/src/mobile-views.ts` — EXHAUSTIVE
   `Record<DeckView, MobileViewMeta>`** (renderer-side, NOT `shared/`). This
   is a compile GATE: the typecheck fails until you declare the new view's
   mobile placement (`'tab'` | `'more'` | `'desktop-only'`). Desktop-first
   read views → `'desktop-only'` (like graph/browser/git/files/sandbox).
3. **`icons.tsx` — `GLYPHS: Record<GlyphName, …>` where `GlyphName` extends
   `DeckView`.** Second compile GATE: the new view does not build until it has
   a glyph. Draw a Greek-styled, stroke-only one per `DESIGN.md` §5 (the
   `deck-design` skill wraps that workflow) — never an emoji, never an icon
   font.
4. **`NavRail.tsx`.** Add `{ id, key }` to `VIEWS` (the icon is looked up as
   `GLYPHS[v.id]`, not declared here). Badges (unread / change counts) mirror
   the inbox badge (`nav-rail-badge`); a best-effort poll here may swallow its
   catch (decorative). Electron-only views are filtered out for `remote`
   clients in the same file.
5. **`App.tsx`.** Conditional `{view === 'x' && (…)}` render (or keep-mounted
   `view-hidden` for views whose DOM/PTY must survive), each wrapped in its own
   `<ErrorBoundary scope="x">`. Modals are store-owned open state mounted flat
   near the end of the same tree (`{fooOpen && <FooDialog />}`), desktop-only
   ones behind `!remote`.
6. **`styles.css`.** Reuse `btn`/`icon-btn`, the CSS variables (`--bg*`,
   `--fg*`, `--accent`, `--border`), and existing view-container patterns
   (`.worktrees-view` head, `.diff-*` colorizer). No new render libs.

## Both sub-chains: i18n + verify

- **Locales — THREE files in lockstep** (`desktop/locales/en.json`,
  `fr.json`, and `EN_DEFAULTS` in `desktop/src/main/i18n.ts`). A parity test
  fails on any mismatch — on KEYS *and* on en.json↔EN_DEFAULTS **values**, so
  copy the English strings verbatim between the two. Prefix keys by domain
  (`nav.*`, `files.*`, `git.*`). For a batch of keys, script the JSON edits
  (`object_pairs_hook=OrderedDict`) rather than hand-editing three files.
- **Verify — run the `/desktop-precommit` checklist** (bun test + smoke build +
  `npm run typecheck` in `desktop/` + locale parity). Update `DESKTOP.md`
  (one highlight paragraph) and `desktop/docs/interface.md` (rail table + a
  view section — a docs-integrity test checks index completeness).
