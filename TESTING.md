# Testing & pre-commit checks

## Who runs what (read this before running anything)

The full gate -- `bun test`, the smoke build, and `npm run typecheck` in
`desktop/` -- is run **once, by whoever sequences the commits**, immediately
before committing.

If you are not the one committing, run only the targeted file:

```bash
bun test tests/<your-file>.test.ts
```

and report that exact command with its result. The full suite is ~113s over
1300+ tests with a large output; replaying it after every edit, or to
re-confirm a green someone else already reported, buys nothing. A targeted run
does miss cross-file breakage: that is deliberate, and the batch gate restores
the guarantee before anything lands. If you suspect a cross-file breakage,
raise it as an open item rather than running the full suite to find out.

A `PreToolUse` hook enforces this. `.claude/hooks/no-full-suite.sh` refuses a
Bash call that runs the whole suite and allows it as soon as something is
staged, staged content being the signal that you are the one committing. Do not
stage merely to unlock it: on a shared checkout that is a louder violation, and
every other session sees it in `git status`.

The hook is allow-list shaped -- it requires an argument naming a test FILE,
rather than listing forbidden spellings -- so an invocation it does not
recognise is refused rather than waved through. Verify it with:

```bash
bash .claude/hooks/no-full-suite-probe.sh    # 28 cases, ~14s
```

**After a fresh clone the hook is inert.** The scripts are versioned but its
registration is not: `.gitignore` excludes `.claude/settings.json`. Re-add a
`PreToolUse` entry with matcher `Bash` running
`bash "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/no-full-suite.sh"`. The probe's
last block checks exactly this and fails if the hook is unregistered or its
path does not resolve. Hooks are loaded at session start, so an already-running
session picks up the change only after a restart.

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

## Catch-all sinks in tests (silent-crash camouflage)

A test that exercises code wrapped in a `catch { reportError(...) }` (or any
other "no silent errors" catch-all -- see the CLAUDE.md rule of the same
name) and then asserts on that sink firing must also fail loudly if the
catch-all fires for the WRONG reason. Otherwise the test observes the right
effect produced by the wrong cause: a `ReferenceError` from a harness that
forgot to inject some identifier trips the exact same `reportError` call as
the real behavior under test, and the two are indistinguishable from the
assertion's point of view. The test goes green on the crash, not on the
behavior.

This is structural here, not anecdotal: every module that correctly follows
"no silent errors" is exposed to it -- the more the convention is applied,
the larger the surface. It bit for real once, on `tests/desktop-approval-defer.test.ts`
(the poller's `reportError` sink caught a harness `ReferenceError` from a
missing export the same way it would have caught the real verdict-poll
failure it was written to test).

**Where it bites, and where it does not** (the boundary matters -- a rule
that does not say where it does not apply gets applied everywhere and then
discarded): only a test that FURNISHES the error sink itself (a fake
`reportError`, a fake journal, a spy on a logger) and then asserts on that
sink is exposed. A test that never observes the sink fails normally on an
unrelated crash, same as any other test -- nothing to guard there.

Population measured 2026-08-04: 3 files fit this shape
(`tests/desktop-approval-defer.test.ts`, `tests/desktop-sandbox-copy.test.ts`,
`tests/desktop-dispatch.test.ts`) -- a handful of positive assertions
("the sink fired"), not an audit-sized population, as of that date. This
count grows with `reportError` ADOPTION, not with time -- every new module
that correctly routes its errors to a sink, and every new test that verifies
that routing, is one more candidate. Re-measure when it matters, do not
assume the 2026-08-04 count still holds.

**The fix, when a test in this shape needs to be touched anyway**: assert on
the sink's CONTENT, not just its occurrence. `tests/desktop-sandbox-copy.test.ts`
is the model to follow -- it checks `captured[0].text` for the expected
message (`"copy plan truncated"`), not just that `captured.length` is 1.
"The sink fired with THIS message" cannot be satisfied by an unrelated
`ReferenceError`; "the sink fired" can.

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

**0b. `tests/` files that need react/react-dom/zustand: go through the
desktop bridge, never a bare import.** The repo root and `desktop/` are two
separate npm trees with no workspaces field, each with their own
`node_modules`. A root-level `tests/*.test.ts` file doing `import 'react'`
directly resolves against the ROOT's copy; `desktop/src/**` components
resolve against `desktop/node_modules`'s copy. Mixing the two inside one
test throws `Invalid hook call... You might have more than one copy of
React in the same app` the moment a component from `desktop/src` renders
under a `createRoot`/`act` sourced from the other copy. Any test that needs
to render a real `desktop/src/renderer` component imports react / react-dom
/ zustand ONLY through `desktop/tests-support/react-test-harness.ts` (a
relative import, physically inside `desktop/`, so its own bare imports walk
up to whichever `node_modules` is nearest — the same one the component
resolves against, in every environment). `tests/desktop-test-hygiene.test.ts`
scans every `.ts`/`.tsx` file under `tests/` for a quoted `react` /
`react-dom` / `zustand` reference (matching the specifier itself, not one
particular import syntax shape -- the template-literal variant is
call-syntax anchored, see that test file for its documented gaps), no
exemptions.

This is a fail-open-in-reverse trap, not just a style rule: locally, root
and `desktop/` both have react installed (root as a CI fallback — see
below), and they simply never collide as long as nothing under `tests/`
imports them directly. The day someone adds that bare import, it breaks
LOUDLY in local dev ("more than one copy of React") while CI — which never
has two copies in the first place, since `desktop/node_modules` doesn't
exist yet at that point in the workflow (see next paragraph) — stays GREEN.
The signal shows up exactly where nobody is looking and disappears exactly
where the decision gets made. Don't "fix" a red local run here by removing
the offending file's real diagnosis; go back to the bridge.

Root also carries `react`, `react-dom` and `zustand` as devDependencies even
though nothing at the repo root imports them directly — do not delete them
as dead weight. The CI step `bun test tests/desktop-*...` runs at the repo
root right after a root `bun install`, but BEFORE `desktop/`'s own `npm
install`, so `desktop/node_modules` does not exist yet on that runner.
`TileArea.tsx` (and any other `desktop/src` component under test) does its
own bare `import 'react'`, unmodified — without a root copy, THAT import
fails to resolve in CI, before any test code runs. Two environments, two
different "nearest `node_modules`", same bridge-file convergence logic; see
the bridge file's own header comment for the full mechanism.

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
