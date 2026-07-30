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

## Time-dependent tests (calendar rot)

A test that injects a FIXED clock must derive every timestamp fixture from
that clock, never from `Date.now()`. Mixing the two makes the test pass at
authoring time and fail months later, when the wall clock has drifted past the
frozen one — a failure that reads like a regression but is pure rot.
Precedent: `desktop-log.test.ts` aged its "stale snapshot" fixture with
`Date.now() - 10 days` while the prune compared against a frozen 2026-07-19,
so it died on 2026-07-22. Same rule for retention/TTL windows: assert the
BOUNDARY relative to the injected clock, not an absolute date.

## Cross-platform tests (the CI matrix)

`.github/workflows/desktop-build.yml` runs the suite on **windows / macos /
ubuntu**. A local `bun test` is Linux-only, so it is structurally blind to two
things — assume neither is covered until CI says so.

**0. Does your file run there at all?** The workflow does NOT run `bun test`;
it runs an explicit list of globs, because the broker integration suites spawn
a daemon and bind ports, which is not what that matrix is for:

```
tests/desktop-*.test.ts   tests/notify-*.test.ts   tests/mobile-shell-*.test.ts
```

A new suite named outside those prefixes runs **on your machine and nowhere
else** — green locally, forever unverified on Windows and macOS. Either name it
to match, or add its glob to the workflow. Check the `paths:` filter too: it
gates whether the job triggers at all, and it once listed only `desktop/**`
while the suites it runs cover `notify/`, `shared/` and `broker.ts`. Precedent:
140 tests shipped that had never executed on any runner.

The gap is measurable and grows silently: `.github/workflows/desktop-build.yml:63`
runs that three-glob line against `tests/`, matching **78 files**. `bun test`
at the repo root collects **116**. A new test must live in `tests/` **and**
carry one of those three prefixes, or CI never runs it, with no failing check
to notice. Verify collection by running the CI glob itself, not by running
`bun test` and counting the files it picked up. Precedent: a guard shipped in
`desktop/src/main/` passed locally and was never executed by CI.

**1. Paths.** macOS tmpdirs are symlinked (`/var` → `/private/var`) and Windows
hands back 8.3 short names; Linux tmpdirs are neither, so any path-comparison
bug is invisible locally. Don't settle for a test that only fails on the other
runner: **reproduce the CONDITION, not the OS.** Build the symlinked prefix in
the fixture (`symlinkSync(real, link, "junction")` — the type arg is the
unprivileged dir flavour on Windows, ignored on POSIX) and drive the API
through the link. That test then fails without the fix on *every* OS, which is
what makes it a regression test rather than a CI-only tripwire. Compare
fixture paths with `realpathSync(...)` on both sides. Precedent:
`desktop-worktree.test.ts`, "paths survive a symlinked repo prefix".

**2. Shell syntax.** Assertions must not hard-code one platform's shell:

| Don't | Do |
|-------|-----|
| `{ command: "pwd" }` | `node -e "process.stdout.write(process.cwd())"` |
| `dir.split("/").pop()` | `realpathSync(out)` vs `realpathSync(dir)` |
| `/< "([^"]+)"$/` (POSIX stdin) | accept the PowerShell `Get-Content -Raw "…" \|` form too |

Assert the **contract** (this file reaches the process as stdin), not one OS's
spelling of it — the per-platform command shapes belong in the pure adapter
tests, which pass an explicit `platform` and run identically everywhere.

**3. Skipping is a debt, pay it in the same commit.** Some tests are POSIX by
construction — they pin `platform: "linux"` and drive a `#!/bin/sh` fixture,
and there is nothing to assert on Windows. Skip them
(`const posixOnly = process.platform === "win32" ? test.skip : test`), but a
skip trades a red X for a **coverage hole**: add OS-agnostic tests covering the
same executor with constructs that behave identically in `sh` and PowerShell
(`echo`, a missing binary). Precedent: `desktop-help.test.ts`, the two
`runHelp` round-trips plus the two portable ones that replace them on Windows.

## Adding a UI string (renderer)

Three files must carry the same key, or `desktop-i18n.test.ts` fails:

1. `desktop/locales/en.json`
2. `desktop/locales/fr.json`
3. `EN_DEFAULTS` in `desktop/src/main/i18n.ts`

Prefix keys by view/domain (`graph.*`, `roadmap.*`, `nav.*`, `common.*`) and
keep the three insertions in the same relative position as their neighbors.
