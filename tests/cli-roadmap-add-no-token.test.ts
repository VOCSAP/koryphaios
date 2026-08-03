// spec_3c736a72: card 01c82fdf -- roadmap-scribe's HTTP fallback for
// roadmap_add forced the calling agent to source and pass
// CLAUDE_PEERS_BROKER_TOKEN itself, which put the literal token value on a
// shell command line and in the session transcript (2026-08-03, twice in one
// day). Measured root cause: server.ts already registers and fully
// implements roadmap_add -- this was never a missing-tool bug. The gap is
// that a session's own MCP tool-list is a harness-side snapshot that can
// omit a tool the server perfectly well advertises (confirmed: one live
// session in this incident had zero roadmap_* tools while another had
// three, despite both connecting to the same server.ts). The fallback WILL
// fire regardless, so the fix closes the token-handling gap in the fallback
// itself: `bun cli.ts roadmap-add --input <file>` resolves the broker token
// internally (env or the global config file, same as every other cli.ts
// command), so it never needs to appear in the invoking command.
//
// This test asserts the TOKEN property, not the feature: the roadmap-add
// code path in cli.ts carries no token-shaped CLI argument, and the skill
// doc that used to sanction "build the request yourself" no longer contains
// the raw-HTTP/Bearer instructions that put the token in an agent's hands.
// A grep-shaped assertion over source text is legitimate and cheap here
// because the property under test IS textual: "does this file ever spell
// out a way to hand the token to a shell command", not runtime behaviour.
//
// Fails closed on regression in both directions:
//   - MISSING verb: if roadmap-add is ever removed from cli.ts (or renamed),
//     the "verb exists" assertion below fails.
//   - REINTRODUCED leak: if raw Bearer/token instructions are ever added
//     back to SKILL.md, or a --token/-t flag is added to cli.ts, the
//     negative assertions fail.
//
// Named tests/cli-*.test.ts, matching the existing tests/broker-*.test.ts /
// tests/server-*.test.ts convention for root-level (non-desktop) suites.
// Per TESTING.md ("Cross-platform tests"), the CI matrix in
// .github/workflows/desktop-build.yml only collects
// tests/desktop-*.test.ts, tests/notify-*.test.ts and
// tests/mobile-shell-*.test.ts -- exactly like the pre-existing
// tests/broker-*.test.ts and tests/server-*.test.ts suites, this one runs
// via local `bun test` (CLAUDE.md pre-commit convention), not the desktop CI
// job; it is not desktop/notify/mobile-shell code, so it does not belong in
// that glob.
//
// Team-lead review, 2026-08-03 (round 2): the first version of this test
// only read cli.ts and SKILL.md, so it passed green while the raw HTTP +
// `Authorization: Bearer` fallback still sat in
// .claude/agents/roadmap-scribe.md -- the file SKILL.md forks into and that
// actually EXECUTES when the fallback fires. A guard that checks the
// document ABOUT the fix but not the file that ACTS on it audits the wrong
// carrier. AGENT_SOURCE below closes that gap; the two negative assertions
// now run over all three sources.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_SOURCE = readFileSync(join(REPO_ROOT, "cli.ts"), "utf-8");
const SKILL_SOURCE = readFileSync(
  join(REPO_ROOT, ".claude", "skills", "roadmap-card", "SKILL.md"),
  "utf-8",
);
const AGENT_SOURCE = readFileSync(
  join(REPO_ROOT, ".claude", "agents", "roadmap-scribe.md"),
  "utf-8",
);

test("cli.ts declares a roadmap-add verb (fails closed if removed/renamed)", () => {
  expect(CLI_SOURCE).toMatch(/case\s+"roadmap-add"\s*:/);
});

test("roadmap-add reads its payload from a file, not from a token-shaped flag", () => {
  // The verb's own block must use --input (file path), and must not declare
  // any --token / -t flag anywhere in cli.ts. A token-shaped flag on this
  // verb's argv surface is exactly the leak this test exists to catch.
  //
  // Block boundary found via the next top-level `case "..."` / `default:`
  // marker rather than a literal "\n  }\n" closing-brace string: cli.ts uses
  // CRLF line endings, so a bare "\n"-only pattern silently never matches
  // (measured -- the first version of this test failed on that, not on a
  // real regression) and would have made this assertion pass vacuously on
  // an empty/wrong slice instead of failing loudly.
  const caseStart = CLI_SOURCE.indexOf('case "roadmap-add"');
  expect(caseStart).toBeGreaterThan(-1);
  const afterMarker = CLI_SOURCE.slice(caseStart + 1).search(/\r?\n  (case "|default:)/);
  expect(afterMarker).toBeGreaterThan(-1);
  const caseEnd = caseStart + 1 + afterMarker;
  const roadmapAddBlock = CLI_SOURCE.slice(caseStart, caseEnd);

  expect(roadmapAddBlock).toContain('"--input"');
  expect(roadmapAddBlock).not.toMatch(/--token|"-t"/);
  expect(CLI_SOURCE).not.toMatch(/--token|["'`]-t["'`]/);
});

test("SKILL.md no longer sanctions building the raw Bearer request itself", () => {
  // Literal absence, not paraphrase: the fallback prose must not spell out
  // either the header shape or the env var name in a form an agent could
  // copy into a shell command. (A "never do X" sentence that still names X
  // verbatim defeats this -- caught when this test was first written: the
  // replacement prose initially still said "Authorization: Bearer" inside
  // its own prohibition and failed this exact assertion.)
  expect(SKILL_SOURCE).not.toMatch(/Authorization:\s*Bearer/i);
  expect(SKILL_SOURCE).not.toContain("CLAUDE_PEERS_BROKER_TOKEN");
  expect(SKILL_SOURCE).toContain("roadmap-add --input");
});

test("roadmap-scribe.md (the file that actually executes the fallback) carries no raw Bearer/token instructions", () => {
  // SKILL.md forks into this agent for the full step-by-step procedure; the
  // agent file is what runs when the fallback fires, so a leak surviving
  // here is live even if SKILL.md itself is clean. Same caught-on-first-draft
  // trap as SKILL.md: the rewrite must not still name the env var or the raw
  // header shape inside its own "never do this" sentence.
  expect(AGENT_SOURCE).not.toMatch(/Authorization:\s*Bearer/i);
  expect(AGENT_SOURCE).not.toContain("CLAUDE_PEERS_BROKER_TOKEN");
  expect(AGENT_SOURCE).not.toMatch(/roadmap\/upsert/i);
  expect(AGENT_SOURCE).not.toMatch(/curl\s/);
  expect(AGENT_SOURCE).toContain("roadmap-add --input");
});
