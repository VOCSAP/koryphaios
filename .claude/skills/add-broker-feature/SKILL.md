---
name: add-broker-feature
description: Checklist of the full-stack layer chain for a feature that travels from an agent (MCP tool) through the broker to the Deck UI — which files to touch, in which order, and which existing pattern to imitate at each layer. Use when adding a broker endpoint/table, a claude-peers MCP tool, or any agent→broker→Deck feature.
---

# Adding a broker-backed feature (agent → broker → Deck)

The repo's cross-cutting features all follow the same nine-layer chain. Work
top-down; at every layer, IMITATE the named existing pattern instead of
inventing. Reference implementation: graph drafts (`graph_drafts` table,
`graph_draft_*` tools, inbox cards) — grep any `graph-draft`/`graphDraft`
symbol to see the whole chain end to end.

## 0. Decide the durability model FIRST

- **Drain semantics** (deliver once, destructive): `messages` table style.
  Anything the Deck must not lose on crash needs a desktop journal on top
  (`inbox-store.ts`).
- **Park semantics** (durable until acted on, non-destructive list):
  `roadmap_items` / `graph_drafts` style — no FK to peers, plain-text author
  snapshot, status flips instead of DELETE. Prefer this for anything awaiting
  operator action.

## 1. Protocol types — `shared/types.ts` (repo root)

Entity + `*Request`/`*Response` interfaces. Imitate the `GraphDraft*` block.

## 2. Shared validation/builders — `shared/<feature>.ts` (optional but preferred)

Pure module (no bun/node imports), used by BOTH broker and server so limits
live once. Prompt constants for one-shot helpers are CODE CONSTANTS here (C8).
Imitate `shared/graph-draft.ts`. Test file: `tests/<feature>.test.ts`.

## 3. Broker — `broker.ts`

- `CREATE TABLE IF NOT EXISTS` + index, next to `graph_drafts`.
- Handlers: imitate `handleGraphDraftAdd/List/Open` (validation → `{ result }`
  or `{ error, status }`).
- Route cases in the big `switch (path)`.
- TTL/tunables: env var pattern
  `Math.max(1, parseInt(process.env.CLAUDE_PEERS_X ?? "default", 10))`, wire
  into `purgeOldMessages()` + the `/admin/purge-messages` response + the
  startup `console.error` line. Document in README's env table.
- Test: `tests/broker-<feature>.test.ts` — `startBroker(env?)` from
  `tests/_helper.ts`, `post()`; backdate rows by writing the SQLite file
  directly (see `broker-message-ttl.test.ts`).

## 4. MCP tool — `server.ts`

- Entry in the `TOOLS` array (name, description, inputSchema). If the tool is
  operator-gated, say so IN the description ("OPERATOR-INVITED ONLY").
- `case` in the CallTool switch: `brokerFetch(path, body)` with
  `roadmapProjectKey()` / `roadmapAuthor()`; return
  `{ content: [{ type: "text", text }] }`, errors with `isError: true`.
- Add one line to the instructions blob ("Available tools:" list).
- Subprocess one-shots: spawn with an ARGV ARRAY (no shell), pinned model,
  `--strict-mcp-config` + `--disallowedTools` — imitate `runDraftOneShot`.

## 5. Deck broker client — `desktop/src/main/broker-client.ts`

Typed fetch helper per endpoint; throws on non-2xx so pollers can swallow.
Imitate `fetchGraphDrafts` / `markGraphDraftOpened`.

## 6. Deck main — `index.ts` and/or `ipc.ts`

- Push flow (broker → renderer): poll in `index.ts` on the `INBOX_POLL_MS`
  timer, send only on change (signature compare), OS `Notification` for new
  items — imitate `pollGraphDrafts`.
- Request flow (renderer → main): `ipcMain.handle` in `ipc.ts` — imitate
  `'graphDraft:open'`. State dir:
  `join(app.getPath('userData'), APP_STATE_SUBDIR)`.
- Deck-local persistence: pure module with injectable dir — imitate
  `inbox-store.ts` (+ `tests/desktop-<feature>.test.ts`).

## 7. Preload — `desktop/src/preload/index.ts`

One `ipcRenderer.invoke` line per handle, one `subscribe('channel', cb)` per
event.

## 8. Deck types — `desktop/src/shared/types.ts`

Renderer-facing types + the `Api` interface: method signatures AND
`on<Event>` subscriptions (returns an unsubscribe fn). The web typecheck
fails if preload and `Api` drift.

## 9. Renderer — `store.ts`, component, styles, locales

- `store.ts`: state field + default, subscription in `init()`, actions.
  Navigation requests between views go through store state (imitate
  `graphFocus` + `clearGraphFocus` consumed by an effect in the view).
- Component: dedupe by id when a live stream and a hydration can race.
- `styles.css`: reuse `btn`/`icon-btn` and the CSS variables; canvas overlays
  need `stopPropagation` (see DESKTOP.md "Renderer view conventions").
- Locales: THREE files (`en.json`, `fr.json`, `EN_DEFAULTS` in `i18n.ts`) —
  see TESTING.md "Adding a UI string".

## 10. Verify

Run the `/desktop-precommit` checklist. Update `ARCHITECTURE.md` (core
protocol) and `DESKTOP.md` (Deck behavior) — one paragraph each.
