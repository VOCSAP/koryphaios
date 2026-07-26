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

## 0.a Decide the KEY first — who can there be two of?

Before the durability model, settle what the feature is keyed by. The broker is
either local or **on a shared server**, so it serves **several people**; each of
them runs **several sessions at once on several PCs**. Every silent bug this
repo has shipped in this area was one singleton keyed by too little:

| Keyed by | Breaks when | Key by instead |
|---|---|---|
| channel `kind` | a second operator enrols → replaces AND stops the first | `(operator_id, kind)` |
| `hostname()` | two OS accounts on one PC share it | `operator_id` (a digest of a public key) |
| the transport's secret, one instance per operator | two operators share ONE bot token → two `getUpdates` consumers, permanent 409 | one instance per TRANSPORT, reference-counted |
| an address resolved to "its" owner | one person points two identities at one chat account → `.get()` picks one row | resolve the OBJECT, then "may this caller act on it" |

Concrete rules that follow:

- **A `SELECT … ` you then `.get()` is a decision to ignore the other rows.**
  Either the column is unique by construction, or you have a bug waiting.
- **Authorisation is asked in the direction that survives a second identity.**
  `approval → is this address paired FOR ITS OWNER` holds; `address → its
  operator → compare` only held while an address belonged to exactly one.
- **A per-process `Map` of live things needs a stop rule.** Two owners may
  legitimately point at ONE instance (same token); stopping must be
  reference-counted or disconnecting one cuts the other.
- **Test it with two.** A single-operator test passes on all of the above. The
  suites that caught these run two operators against one broker
  (`tests/broker-ntfy-channel.test.ts`) or register two slots on one fake
  channel (`tests/notify-registry.test.ts`).

## 0.b Decide the durability model

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
- **A route that REPLACES a stored secret/config must vet the candidate
  BEFORE overwriting.** Writing first and deleting on failure destroys a
  working configuration whenever the provider is briefly unreachable — and
  leaves the row and its dependants inconsistent. Imitate `handleChannelConnect`:
  build and `describe()` the candidate, and only then persist and swap.
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

> **If the feature exposes a new `DeckApi` method, ALSO follow steps 7-8 of the
> `add-deck-view` skill before compiling.** Every DeckApi member must appear in
> `COMPANION_MANIFEST` *and* in `CHANNEL_TIERS` (`desktop/src/shared/companion.ts`)
> — the first is a typecheck error, the second a test failure, and they fire
> late (after the renderer work is done). Decide the tier at the same moment:
> anything that accepts a SECRET or hands one out belongs in
> `REMOTE_BLOCKED_CHANNELS` too, because a paired phone reaches every channel
> that is not blocked.

> **Importing repo-root `shared/` from `desktop/src/main/`.** It works (the main
> build has no `root` restriction) but the file must be listed in
> `desktop/tsconfig.node.json` `include`, one entry per file — do NOT add
> `../shared/**/*`, that pulls in Bun-only modules (`config.ts` uses `Bun.file`)
> and breaks the typecheck. Prefer this over mirroring for anything
> cryptographic: a one-byte drift in a canonical serialization silently
> invalidates every signature.
>
> **The same rule holds for any WIRE FORMAT with two ends**, and it is what
> decides where a module lives. `notify/ntfy-protocol.ts` is imported by the
> broker AND bundled into the Android app, so it must stay dependency-free —
> which is why `stripControl`/`truncate` were moved out of `shared/approval.ts`
> (it pulls `node:crypto`) into the leaf `shared/text.ts`. When one end cannot
> import it at all (Kotlin), the restatement is unavoidable: say so at BOTH
> sites, name the module that is authoritative, and keep the restated part as
> small as possible. Shared string constants are worth exporting for this
> alone — `COMPANION_CRED_STORAGE_KEY` exists because the same key was spelled
> twice in two projects.

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
