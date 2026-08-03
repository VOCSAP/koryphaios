// Thin re-export so root-level `tests/*.test.ts` files can pull react /
// react-dom / zustand through DESKTOP's own node_modules instead of a
// second, root-level copy of the same packages.
//
// Why this file has to exist: desktop/ and the repo root are two separate
// npm-managed trees (no workspaces field), each with their own node_modules.
// A bare `import 'react'` from a file physically under tests/ resolves
// against the ROOT's node_modules; a bare `import 'react'` from
// desktop/src/renderer/src/components/TileArea.tsx resolves against
// desktop/node_modules -- a DIFFERENT physical copy of the package, even at
// the same version. React refuses to run across that split ("Invalid hook
// call... You might have more than one copy of React in the same app"),
// because the rendering dispatcher lives on one copy's module state while
// the component tree calls hooks against the other.
//
// This file lives INSIDE desktop/, so its own bare imports resolve against
// desktop/node_modules -- the same copy TileArea.tsx (and every other
// desktop/src/renderer component) uses. A root-level test imports THIS file
// by relative path (not by bare specifier), which sidesteps Node/Bun's
// package resolution entirely and guarantees a single React instance across
// the test's `createRoot`/`act` calls and the real component tree they
// render.
//
// CI note -- do NOT "clean up" react/react-dom/zustand out of the ROOT
// package.json devDependencies because this bridge makes them look unused.
// They are not unused, they cover the OTHER environment. In CI,
// `.github/workflows/desktop-build.yml` runs `bun test tests/desktop-*...`
// at the repo root right after a root `bun install`, but BEFORE `npm
// install` runs inside desktop/ -- so on that runner, desktop/node_modules
// does not exist yet. Node/Bun's "nearest node_modules" resolution then
// walks up past desktop/ (nothing there) to the repo root. Both this
// bridge file AND TileArea.tsx's own bare `import 'react'` walk up the
// same way, so they still land on the SAME copy as each other -- but only
// if the repo root actually has react/react-dom/zustand installed. Remove
// them from root and TileArea.tsx itself fails to resolve `react` in CI,
// before this bridge (or the test) ever runs. Locally, where
// desktop/node_modules already exists, both this bridge and TileArea.tsx
// resolve to THAT copy instead, and the root copies sit unused -- that is
// expected, not a sign they can be deleted. Two environments, two
// different "nearest" node_modules, same convergence logic; the root
// copies are CI's fallback, not local dead weight.
//
// Known consequence, accepted deliberately: root and desktop/ are not
// pinned to the same react PATCH version, so this test runs against a
// DIFFERENT react patch locally (desktop's copy) than in CI (root's copy).
// Root's devDependency range is `~19.2.0` (react/react-dom) and `~5.0.0`
// (zustand) -- tightened from an earlier unbounded `^19.0.0`/`^5.0.0` so a
// future root `bun install` can't silently drift the gap wider (e.g. root
// jumping to 19.5 while desktop stays locked at 19.2 via its own
// lockfile); the tilde bounds root to desktop's MINOR, not its exact patch.
// Confirmed 19.2.6 (desktop/node_modules) vs 19.2.8 (root node_modules) as
// of 2026-08-03 -- that patch-level gap is accepted, judged safe for what
// this harness observes (mount/unmount instance persistence across
// re-renders) since both are patches of the same React 19 minor -- but do
// not assume that holds for every future test added against this bridge;
// re-check if you see environment-only failures. If desktop/'s own lockfile
// ever moves to a new MINOR (19.3+), this range needs a matching manual
// bump -- the tilde does not track desktop/'s version automatically.
// React 19's `act()` warns ("The current testing environment is not
// configured to support act(...)") unless the host declares itself an act
// environment via this global, checked by react-dom before flushing
// effects synchronously inside `act()`. Effects still flush and this
// harness's mount/unmount counters are still correct WITHOUT this flag
// today -- but that is an undeclared, unrequested contract: if a future
// React release tightens this check, the harness goes non-deterministic
// silently instead of failing loudly. Set it explicitly so the guarantee
// is asked for, not assumed.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export { act } from 'react'
export * as React from 'react'
export { createRoot, type Root } from 'react-dom/client'
export { create } from 'zustand'
