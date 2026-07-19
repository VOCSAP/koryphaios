# Testing & pre-commit checks

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Checks before committing

- `bun test` -- the full suite (core broker/server + desktop pure modules).
  Broker suites spin up an ephemeral broker on a random port via
  `tests/_helper.ts` (env-scrubbed so developer-side `CLAUDE_PEERS_*` vars do
  not leak in) and tear it down in `afterAll`. Desktop suites test the pure
  modules (no electron import: dirs and ciphers are injected).
- Smoke check: `bun build --target=bun broker.ts server.ts cli.ts
  --outdir=/tmp/cp-check` bundles all entrypoints in ~20 ms and surfaces any
  import or type-resolution error.
- `npm run typecheck` in `desktop/` (tsconfig.node + tsconfig.web).
- Locale parity: `desktop/locales/en.json`, `fr.json` and the embedded
  `EN_DEFAULTS` (`desktop/src/main/i18n.ts`) must carry the same key set
  (enforced by `tests/desktop-i18n.test.ts`).

The `desktop-precommit` skill (`.claude/skills/`) walks this checklist with
the workarounds for the known environment quirks below.

## Environment quirks (remote/proxied sessions)

- Fresh container: run `bun install` (root) before the smoke check, and
  `npm install` in `desktop/` before the typecheck. Since Electron 42 the
  `electron` package no longer downloads its binary in postinstall (it
  downloads on first launch; `ELECTRON_SKIP_BINARY_DOWNLOAD` is gone), so a
  plain install works behind the proxy. The desktop postinstall's
  `electron-rebuild` still 403s on the Electron headers download — its
  `|| echo` fallback absorbs that; run `npm run rebuild` on a real machine.
- `tests/server-stdin-eof.test.ts` is flaky in sandboxed environments: re-run
  it in isolation before treating a failure as a regression.

## Adding a UI string (renderer)

Three files must carry the same key, or `desktop-i18n.test.ts` fails:

1. `desktop/locales/en.json`
2. `desktop/locales/fr.json`
3. `EN_DEFAULTS` in `desktop/src/main/i18n.ts`

Prefix keys by view/domain (`graph.*`, `roadmap.*`, `nav.*`, `common.*`) and
keep the three insertions in the same relative position as their neighbors.
