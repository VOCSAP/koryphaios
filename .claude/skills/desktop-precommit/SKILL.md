---
name: desktop-precommit
description: Run the Koryphaios pre-commit checks (bun test, smoke build, desktop typecheck, locale parity) with the known environment workarounds. Use before committing in this repo, or when bun test / npm run typecheck fail with missing-module errors, an Electron 403 download error, or a flaky-looking test failure.
---

# Pre-commit checks (with environment workarounds)

Run these from the repo root, in this order. Skip step 3 when `desktop/` was
not touched. Details on the suite layout live in `TESTING.md`.

## 1. Full test suite

```bash
bun test          # ~75 s, 480+ tests
```

- **A failure is not a regression until re-run in isolation**:
  `bun test tests/<file>.test.ts`. `tests/server-stdin-eof.test.ts` is known
  to be flaky in sandboxed/proxied environments (spawn + stdin timing).
- Still failing in isolation? Confirm against a clean base before debugging:
  `git worktree add <scratchpad>/base origin/<base-branch>` and run the same
  file there (then `git worktree remove --force <scratchpad>/base`). If it
  fails there too, it is pre-existing/environmental — say so, don't "fix" it.

## 2. Smoke build (core entrypoints)

```bash
bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check
```

- `error: Could not resolve: "..."` on a fresh container just means deps are
  not installed: run `bun install` (repo root), then retry.

## 3. Desktop typecheck (only if `desktop/` was touched)

```bash
cd desktop && npm run typecheck    # runs tsconfig.node + tsconfig.web
```

- `TS2688: Cannot find type definition file for 'electron-vite/node'` means
  `desktop/node_modules` is not installed.
- Plain `npm install` FAILS in remote/proxied environments: the Electron
  postinstall downloads a binary and gets **HTTP 403** from the agent proxy.
  The typecheck does not need that binary (nor the node-pty rebuild):

```bash
cd desktop && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
```

## 4. Locale parity (only if UI strings were added)

Every renderer string must exist in THREE places with the same key:
`desktop/locales/en.json`, `desktop/locales/fr.json`, and `EN_DEFAULTS` in
`desktop/src/main/i18n.ts`. Parity is enforced by
`tests/desktop-i18n.test.ts` (part of step 1) — if you skipped step 1 after
adding strings, at least run that file. Key prefixes follow the view
(`graph.*`, `roadmap.*`, `nav.*`, `common.*`).

## 5. Commit

Nothing repo-specific beyond the above; describe the change, not the checks.
