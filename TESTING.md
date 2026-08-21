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

- `bun scripts/check-commit-closure.ts --staged` -- ~2 s. "If I commit right
  now, does this commit stand on its own?" See "Commit closure check" below.
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

## Commit closure check (import closure + control bytes)

`scripts/check-commit-closure.ts` answers two questions a diff review and
`bun test` both miss, because both read the WORKING TREE while the thing
that ships is a TREE OBJECT:

1. **Import closure.** Every relative (`./` `../`) and `@shared/*`-aliased
   import in a scanned file must resolve, against the tree being checked,
   to a real file that actually exports the named symbol. Catches "this
   commit references code that only exists in the working tree" -- it
   builds for the author and breaks for the next person who checks the
   commit out clean. `@shared/*`'s target is read from
   `desktop/tsconfig.web.json` / `desktop/tsconfig.node.json` AT THE REF
   being checked (not off disk), and the two tsconfigs disagreeing on that
   target is itself reported.
2. **Literal control bytes** (NUL, ESC, BEL) in a committed/staged blob --
   the defect that makes git classify a whole file BINARY: no diff, no
   blame, no 3-way merge, ripgrep refuses to show it. Every file is scanned
   EXCEPT a deny-list of known-binary extensions (`BINARY_EXT_RE`: images,
   fonts, archives, compiled/native artifacts, ...). This was inverted from
   an allow-list on purpose: an allow-list of what to inspect fails OPEN as
   the repo's domain grows -- measured on this tree, the allow-list scanned
   only 391 of 401 tracked files, silently skipping 5 `.kt`, 4 `.gitignore`
   (the leading dot read as an extension) and 1 `.example`. The deny-list
   scans 401 of 401 today; a newly added binary format is a loud red
   finding on the commit that adds it, not a silent coverage gap.

Two modes, same logic underneath:

```bash
bun scripts/check-commit-closure.ts --staged        # the index: pre-commit
bun scripts/check-commit-closure.ts <sha> [repo]     # a real commit: audit / CI
```

`--staged` is the cheap (~2 s), everyday check -- see the `desktop-precommit`
skill. `<sha>` mode is what CI runs across a PR's commit range, so a commit
that only ever went through someone's local `--staged` check (or was never
checked at all) still gets caught before merge.

**The two gaps that decide whether the fast check is enough, or you need the
slow path instead** (the script's own header comment is the complete,
current list of every known gap -- restated here only for these two,
because a duplicated full list drifts out of sync with the code the moment
either changes; these are singled out because they change what you should
DO next, not just what the tool cannot see):

1. Only scans files IN the commit/stage being checked -- a commit that
   renames or deletes an export breaks already-committed importers
   elsewhere in the tree, and none of those files are in this commit's
   file list. Not caught.
2. Checks that a same-NAME export exists, not that its SHAPE still matches
   -- a signature/type change under the same name stays green. This is
   exactly when to escalate to the slow path: a full checkout of the
   commit into a clean tree + `npm run typecheck` (minutes, mostly
   `desktop/`'s own `npm install`) -- run it when doubt remains after the
   fast check passes, not on every commit.

Sensitivity and specificity are both proven, against real git repos built
by `scripts/fixtures/make-closure-sensitivity-repo.ts` (ships in the same
commit as the checker on purpose -- a proof nobody can replay after the
next refactor is not a proof), by `tests/desktop-commit-closure-check.test.ts`.

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

## Computed-layout defects (no layout engine in this suite)

Neither jsdom nor happy-dom (the two DOM harnesses this suite uses) ships a
real layout engine: `getBoundingClientRect`, `offsetHeight`, `offsetTop` and
`offsetParent` are stubbed (zero / `null`) in both, confirmed 2026-08-21 by
`grep -rn "getBoundingClientRect\|offsetTop\|offsetHeight\|clientHeight" tests/`
returning zero hits across the whole suite -- nobody has ever been able to
rely on them here. A defect whose repro depends on the RESOLVED, COMPUTED box
(e.g. a flex row with `align-items: center` centering on its tallest child,
producing a few px of vertical offset that depends on the font actually
resolved) cannot be caught by an assertion on the CSS rule text or on any
`getComputedStyle` value that doesn't require box geometry -- the code
correctly follows the rule either way, so such an assertion would pass
whether the visual bug is present or not (the exact false-witness shape the
CLAUDE.md coverage rule warns about).

This class stays a **manual validation step**, not an automated guard: drive
a real Koryphaios instance over CDP (screenshot or computed-style read on a
live, laid-out page, not jsdom/happy-dom) and read the actual pixel/computed
values. Three real defects were caught this way in one review pass
(2026-08-21): a stale composer-reopen seed (now guarded automatically, see
`tests/desktop-templates-composer-seed.test.ts`), a ~7.5px flex-centering
offset (this class -- visual-only), and a focusable-element count inflated by
`querySelectorAll` matching under `display: none` (a probe defect, filed as
roadmap debt for the collapsed-panel accessibility invariant it pointed at,
not a product regression). Introducing a real-browser runner (e.g.
Playwright) would close this gap with an automated guard, at the cost of a
new dependency, a new CI job and a maintainer for it -- not decided in this
lot; flag it as its own proposal if the manual-review cost becomes the
bottleneck.

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

The gap is measurable and grows silently: `.github/workflows/desktop-build.yml:79`
runs that glob line (nine prefixes now, not the three it started with) against
`tests/`, matching **92 files** as of 2026-08-05. `bun test` at the repo root
collects **130**. A new test must live in `tests/` **and** carry one of those
prefixes, or CI never runs it, with no failing check to notice. Verify
collection by running the CI glob itself, not by running `bun test` and
counting the files it picked up. Precedent: a guard shipped in
`desktop/src/main/` passed locally and was never executed by CI. A second
precedent, card b33b1874 (2026-08-05): `desktop-roadmap-service.test.ts`
matched the `desktop-*` prefix (collected) while genuinely spawning a real
broker daemon on a bound port (a real `from ".../_helper.ts"` import) --
`tests/desktop-ci-glob-coverage.test.ts`'s coverage guard only ever checked
that the EXEMPT family/file list carries the daemon signal, never the
inverse (a COLLECTED file must not carry it), so an integration suite ran
unflagged inside the cross-platform pure-module job. Fixed by renaming it
into the already-exempted `broker-` family (`broker-desktop-roadmap-service.test.ts`)
and by adding the missing symmetric check. These counts move fast under
concurrent editing (this repo regularly runs 8-10 parallel sessions); treat
them as a snapshot for the stated date, not a standing truth -- re-measure
rather than trust a number without one.

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
