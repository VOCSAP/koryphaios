// Card 6aa32af4: pins the operator's invariant -- "project_key a toujours
// une valeur determinee et reproductible pour un meme cwd" -- against the
// single shared derivation both peer registration (/register) and roadmap
// card scoping (server.ts's roadmapProjectKey()) now route through. Before
// this, the two sites diverged: a peer with no git remote registered
// project_key=null while its own roadmap cards were scoped to a non-null
// local:<hash> fallback, and releaseStaleLocks' NULL-safe `IS` comparison
// (card fc444eda) then read "different key" as "not this peer's card",
// sweeping a live peer's own lock as owner-gone.
//
// Pure module, no broker/server process involved -- resolveProjectKey has
// no I/O, so this is a straight unit test, not an HTTP round-trip like
// tests/roadmap-broker-lock.test.ts (which still covers the raw-client
// squat scenario: a client posting project_key:null directly over HTTP,
// bypassing this derivation entirely).

import { test, expect } from "bun:test";
import { resolveProjectKey } from "../shared/project-key.ts";

test("same inputs always resolve to the same value (remote present)", () => {
  const a = resolveProjectKey("github.com/vocsap/koryphaios", "/repo", "/repo");
  const b = resolveProjectKey("github.com/vocsap/koryphaios", "/repo", "/repo");
  expect(a).toBe(b);
  expect(a).toBe("github.com/vocsap/koryphaios");
});

test("same inputs always resolve to the same value (no remote, local fallback)", () => {
  const a = resolveProjectKey(null, "/some/git/root", "/some/cwd");
  const b = resolveProjectKey(null, "/some/git/root", "/some/cwd");
  expect(a).toBe(b);
  expect(a).toMatch(/^local:[0-9a-f]{16}$/);
});

test("remote project_key wins over the local fallback anchor", () => {
  const withRemote = resolveProjectKey("github.com/vocsap/koryphaios", "/repo", "/repo");
  expect(withRemote).toBe("github.com/vocsap/koryphaios");
  expect(withRemote.startsWith("local:")).toBe(false);
});

test("no git root falls back to cwd as the local-hash anchor", () => {
  const a = resolveProjectKey(null, null, "/no/git/repo/here");
  const b = resolveProjectKey(null, null, "/no/git/repo/here");
  expect(a).toBe(b);
  expect(a).toMatch(/^local:[0-9a-f]{16}$/);
});

test("git root and cwd anchors are independent -- different cwd under the same git root still agrees", () => {
  // Mirrors the real shape: myGitRoot is stable for a repo, myCwd can be a
  // subdirectory of it. The fallback anchors on git_root when present, so
  // two sessions in different subdirectories of the same repo (same
  // git_root, no remote) must still resolve to the same key.
  const a = resolveProjectKey(null, "/repo", "/repo/packages/a");
  const b = resolveProjectKey(null, "/repo", "/repo/packages/b");
  expect(a).toBe(b);
});

test("never returns null or empty -- the operator's invariant holds for every branch", () => {
  const cases: Array<[string | null, string | null, string]> = [
    ["github.com/x/y", "/repo", "/repo"],
    [null, "/repo", "/repo"],
    [null, null, "/cwd"],
  ];
  for (const [remote, gitRoot, cwd] of cases) {
    const key = resolveProjectKey(remote, gitRoot, cwd);
    expect(key).toBeTruthy();
    expect(typeof key).toBe("string");
  }
});
