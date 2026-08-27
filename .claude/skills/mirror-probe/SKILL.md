---
name: mirror-probe
description: Mutate and probe code in THIS repo without writing to the shared working tree -- the four measured mirror recipes (desktop module lot, core broker/server lot, git-ls-files domain, CI workflow text), plus the Windows and Git Bash traps that make a mirror lie (Write tool /tmp is not Git Bash /tmp, bun test needs a ./ prefix, sed rewrites CRLF, MSYS mangles inline perl). Trigger before mutating any file to test whether a guard bites, before running a mutation battery, or when a probe returns a green that looks too easy. French triggers -- "je veux muter ce fichier pour voir si le test mord", "sonde sans toucher au repo", "miroir dans /tmp", "batterie de mutations". The METHOD (what to mutate, sensitivity vs coverage) lives in the global guard-coverage-audit and wiring-mutation-audit skills; this one is only the local plumbing.
---

# Mirror probes in this repo

## Why a mirror and not `git checkout --`

This working tree is shared by several sessions and **nothing is committed
until the batch gate**, so a mutated file usually sits on top of someone
else's uncommitted work. `git checkout -- <file>` silently replaces it with
HEAD and leaves a clean `git status`. Measured 2026-08-17: caught only because
a byte backup existed and the md5 did not match.

A fix here is assigned to a FILE, not to a subject. Before accepting or
proposing one, name the file and ask who HOLDS it: "who wrote this" and "who
holds this now" are different questions and only the second is safe. Never let
a mutate-and-restore writer share a file with a permanent writer, even with an
agreed ordering. Park the second fix until the first releases.

## Recipe 1 -- a `desktop/src/main` module (the common case)

Root `tests/` import these by relative path, so a mirror resolves them:

```
mkdir -p /tmp/<lot>/desktop
cp -r desktop/src /tmp/<lot>/desktop/
cp -r shared /tmp/<lot>/
cp package.json /tmp/<lot>/
cp tests/<the 3-4 relevant>.test.ts /tmp/<lot>/tests/
ln -s <repo>/node_modules /tmp/<lot>/node_modules
cd /tmp/<lot> && bun test ./tests/<file>.test.ts
```

~2 MB, ~0.2 s per run. Measured 2026-08-18 on card 4df14b5b: baseline
`53 pass`, and after deleting a wiring line from `approval-service.ts`
(`grep -c` confirming 0 occurrences left) still `53 pass` -- the hole, proven
without touching the repo.

## Recipe 2 -- a CORE lot (broker / server / E2E)

```
cp -r shared tests notify /tmp/<lot>/
cp server.ts broker.ts cli.ts index.ts package.json tsconfig.json /tmp/<lot>/
cp -r desktop/src desktop/tests-support desktop/locales /tmp/<lot>/desktop/
ln -s ... node_modules   # both of them
```

**`notify/` is the one everyone forgets, and its absence does not look like an
incomplete mirror.** The E2E reports `could not start broker on any port`
(3 fail); only `bun broker.ts` by hand says
`Cannot find module './notify/registry.ts'`. So ALWAYS run the untouched suites
in the mirror first and match their counts against the author's, before
crediting any red or green to a mutation. Measured 2026-08-19, card e3f8065d.

## Recipe 3 -- a test whose domain is `git ls-files`

```
mkdir -p /tmp/<lot>/tests
git archive HEAD desktop | tar -x -C /tmp/<lot>
cd /tmp/<lot> && git init && git add desktop
cp package.json tsconfig.json ... && ln -s node_modules && cp <testfile> tests/
```

Measured 2026-08-25: the mirror returned **259 tracked / 193 `.ts|.tsx`**,
identical to the real repo, and reproduced the author's exact
`19 pass 0 fail 47 expect()`. This is what lets you `git add` probe files to
change the domain without touching the shared checkout.

## Recipe 4 -- a gate that reads WORKFLOW TEXT

The gate's helpers are usually module-private. Re-export them into a probe
module instead of copying the whole test:

```
mkdir -p /tmp/<lot>/{tests,.github/workflows,desktop}
# copy the workflow + the tsconfigs + desktop/package.json, then:
sed -n '1,<last-line-before-first-test>p' <testfile> \
  | sed 's/^import .*bun:test.*//' \
  | sed -E 's/^(function |const NAME|interface )/export \1/' > tests/gate.ts
```

then write probes importing `./gate.ts`. ~30 s, zero repo writes. Measured
2026-08-26 on `tests/desktop-ci-typecheck-coverage.test.ts`.

## Traps that make a mirror lie

- **The Write tool's `/tmp` is `C:\tmp`; Git Bash's `/tmp` is
  `%LOCALAPPDATA%\Temp`.** A `perl -0pi /tmp/x.pl` then dies with "Can't open
  perl script" while the pipeline around it keeps printing plausible output.
  Write, then `cp` across, or write directly to a Git-Bash-visible path.
- **`bun test tests/x.test.ts` inside a mirror needs the `./` prefix.** Without
  it bun treats the argument as a name FILTER and matches nothing, which reads
  as a pass.
- **`sed -i` / `perl -pi` rewrite a CRLF file to LF and `git diff` hides it.**
  Measured 2026-08-19 on `server.ts`: one substitution plus its exact inverse
  restored the TEXT but the file went 84237 -> 82227 bytes (2010 CRs dropped),
  while `git diff --numstat` still read `19 2`. In a disposable mirror this is
  free (every restore is a `cp` from the original); in place it is not.
- **MSYS mangles an inline perl expression** containing `/` plus `[...]`: a
  substitution that matched on a scratch file silently became a no-op through
  the shell, twice. Use a perl SCRIPT FILE (`perl -0pi /tmp/x.pl <file>`).
- **Always print an `applied` flag** comparing mutated text to the original. A
  `.replace()` whose anchor drifted returns a green that means nothing.
- **Use ABSOLUTE paths in every Bash call.** Whether cwd persists between calls
  has been observed BOTH ways on this harness (a 2026-08-19 note says it does
  not; 2026-08-27 it did, and a relative `cd` landed inside
  `desktop/.claude/...`). Do not depend on either.
- **Two commands the shape guard refuses:** `rm -rf /tmp/<dir>` (pick a fresh
  directory name per lot instead of clearing one), and any `sed`/`perl`
  carrying `\x00`-style escapes (use the Edit tool for that mutation).
- **A plain `bun run` on a file importing a `test(...)` module** dies with
  "Cannot use test outside of the test runner". Put the probe in a throwaway
  `tests/zz-probe.test.ts` INSIDE the mirror.

## Where a probe must live to actually run in CI

**Re-measure before asserting anything here.** Measured 2026-08-27:
`.github/workflows/desktop-build.yml:91` runs a single
`bun scripts/partition-pure-tests.ts`, which card 0bbac537 introduced to
REPLACE the old explicit `bun test <globs...>` allow-list. It is a deny-list
now: a new file runs by default, and `scripts/pure-module-partition.ts`'s
`EXEMPTIONS` table is what has to justify skipping one.

Consequence: **the widely-cited "CI collects 78 of 116 files" trap describes
the state BEFORE that card.** `ls tests/*.test.ts | wc -l` is 215 today, 132 of
them `desktop-*`. Treat any memory, comment or doc repeating the 78/116 figure
as a claim to re-measure, and audit the new `EXEMPTIONS` deny-list instead --
per the global `guard-coverage-audit` skill, a deny-list is the half that fails
OPEN.

## Two "obvious fixes" that do not bite

Offer neither without replaying it (measured the same day):

- A guard-of-the-guard comparing a threshold against ONE known count
  (`expect(counts.get('ts')).toBeGreaterThan(THRESHOLD)`) catches only absurd
  values. `THRESHOLD = 100` left the census inspecting a single extension and
  stayed green. Bound the DOMAIN, not the sensitivity.
- A source-scan assertion on the PRESENCE of a string is vacuated by dead code:
  an inline `return` added ABOVE the original JSX leaves the string in the
  file, so the count is identical mutated and pristine. Only a render-level
  test bites (`desktop/tests-support/react-test-harness` + happy-dom, pattern
  in `tests/desktop-explorer-selection-dom.test.ts`).
