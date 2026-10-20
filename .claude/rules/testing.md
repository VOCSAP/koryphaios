---
paths:
  - "tests/**"
  - "scripts/*partition*"
  - "scripts/fixtures/**"
  - "desktop/tests-support/**"
---

# Writing and running tests

- `mock.module` of a project file returns its whole runtime export surface: `tests/_mock-module-guard.ts` (preloaded by `bunfig.toml`) throws otherwise. For `store.ts` use `mockStore({ useDeck, ...storeMockStubs })` from `tests/_store-mock.ts`, then override the selector under test after the spread.
  Why: the first materialised mock freezes the module's export list for the whole process, and `storeMockStubs` pins the count selectors (`roadmapConflictCount`, `inboxPendingCount`) to zero.
- Await a promise that a collaborator may never settle through `reachedWithin(promise, what)` from `tests/_bounded-await.ts`.
  Why: bun's per-test timeout does not interrupt such an await, so the run hangs instead of turning red.
- Open a running broker's SQLite file from a test only with `openBrokerDb` (`tests/_helper.ts`).
  Why: `bun:sqlite` defaults to a zero busy timeout against the broker's WAL writer, which makes the test flaky.
- A test that launches `server.ts` or `broker.ts` passes `env: scrubEnv(...)` in the launch options and adds its file to `EXPECTED_LAUNCHES` (`tests/_spawn-discipline.ts`).
  Why: an unscrubbed child inherits this session's peer identity and overwrites the identity file of the tile that spawned it.
- Gate a test that needs an environment or artefact with `test.skipIf(cond)`, and name the missing condition in the test name; never `if (!cond) return` in the body.
  Why: an early return counts as a pass and cannot be told apart from real coverage.
- `bun test` runs under `TZ=UTC`: a guard that stamps with SQLite `datetime('now')` and compares in TypeScript is tested with the broker started under a non-UTC `TZ` (as `tests/broker-roadmap-lock-park-tz.test.ts` does).
  Why: a timezone offset defect is invisible to every test run in UTC.
- When a text scan is unavoidable (CLAUDE.md, "Rules for tests"), extract the body with `tests/_braced-body.ts`, never a hand-written regex or brace counter.
  Why: it throws when the depth never returns to 0; a hand-rolled extractor returns a truncated body and the guard shrinks silently.
- Pick a targeted run by grepping `tests/` for the changed SYMBOL, not the changed file; touching broker SQL adds `tests/*discipline*.test.ts`, touching `desktop/src/main/index.ts` adds every test that extracts a body from it.
  Why: the guards that turned the full gate red lived far from the files the lot touched.
- Report a red-first proof with the assertion it fails on; a red on `Export named ... not found` or `Cannot find module` proves nothing.
  Why: that red only shows the code did not exist yet, and the test may not even import the file carrying the decision.
- A fixture that runs `git` in a throwaway repository passes `-c core.hooksPath=` on every call (`scripts/fixtures/make-closure-sensitivity-repo.ts`).
  Why: the host's global git hooks run in each throwaway repo and push the fixture past its timeout on some machines only.
- In a happy-dom test, mount and click under `await act(async () => ...)`.
  Why: a synchronous `act` renders the empty first frame, so assertions read zero elements, and a handler's late `setState` escapes `act`.
