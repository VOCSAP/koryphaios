---
name: desktop-precommit
description: Run the Koryphaios pre-commit checks (commit closure check, bun test, smoke build, desktop typecheck, locale parity) with the known environment workarounds. Use before committing in this repo, or when bun test / npm run typecheck fail with missing-module errors, an Electron 403 download error, or a flaky-looking test failure.
---

# Pre-commit checks (with environment workarounds)

Run these from the repo root, in this order. Skip step 4 when `desktop/` was
not touched. Details on the suite layout live in `TESTING.md`.

## 1. Commit closure check (staged)

```bash
bun scripts/check-commit-closure.ts --staged
```

~2 s. Answers "if I commit right now, does this commit stand on its own?" --
resolves every relative and `@shared/*` import against the INDEX (falling
back to HEAD for files the stage does not touch), and scans staged text
files for literal control bytes (NUL/ESC/BEL, the defect that silently
turns a file binary to git). Exit 0 = clean, exit 1 lists the problem(s).
Run this before every commit on a shared checkout -- it is the cheap check;
escalate to a full checkout + `npm run typecheck` (step 4) only if this
passes but doubt remains (it does not catch a signature change under the
same export name, only a missing/renamed export -- see the gaps documented
at the top of `scripts/check-commit-closure.ts`). See `TESTING.md` for the
`<sha>` mode used by CI over a PR's commit range.

## 2. Full test suite

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

- **Green here is not green in CI.** This run is Linux-only; the matrix also
  builds on windows/macos. Two bug classes cannot fail locally: path
  comparisons (Linux tmpdirs are not symlinked, so `/var` → `/private/var` and
  Windows 8.3 names never bite) and POSIX-shaped assertions (`pwd`,
  `split("/")`, `< "file"`). If you touched path handling or wrote a test that
  shells out, read the "Cross-platform tests" section of `TESTING.md` BEFORE
  pushing — and make the regression test build the symlinked prefix itself, so
  it fails on every OS rather than only on the runner.

## 3. Smoke build (core entrypoints)

```bash
bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check
```

- `error: Could not resolve: "..."` on a fresh container just means deps are
  not installed: run `bun install` (repo root), then retry.

## 4. Desktop typecheck (only if `desktop/` was touched)

```bash
cd desktop && npm run typecheck    # runs tsconfig.node + tsconfig.web
```

- `TS2688: Cannot find type definition file for 'electron-vite/node'` means
  `desktop/node_modules` is not installed.
- Plain `npm install` works, even behind the agent proxy: since Electron 42
  the `electron` package downloads its binary on first launch, not in
  postinstall (`ELECTRON_SKIP_BINARY_DOWNLOAD` no longer exists). Expect the
  desktop postinstall's `electron-rebuild` to print an **HTTP 403** error
  (Electron headers blocked by the proxy) and be absorbed by its `|| echo`
  fallback — harmless here; the typecheck needs neither the binary nor the
  node-pty rebuild. Run `npm run rebuild` on a real machine instead.

```bash
cd desktop && npm install
```

## 5. Locale parity (only if UI strings were added)

Every renderer string must exist in THREE places with the same key:
`desktop/locales/en.json`, `desktop/locales/fr.json`, and `EN_DEFAULTS` in
`desktop/src/main/i18n.ts`. Parity is enforced by
`tests/desktop-i18n.test.ts` (part of step 1) — if you skipped step 1 after
adding strings, at least run that file. Key prefixes follow the view
(`graph.*`, `roadmap.*`, `nav.*`, `common.*`).

## 6. Commit

Nothing repo-specific beyond the above; describe the change, not the checks.
