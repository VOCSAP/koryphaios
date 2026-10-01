import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { scrubEnv } from "./_scrub-env.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "probe-auq-test-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROBE = join(REPO_ROOT, "scripts", "probe-askuserquestion-hooks.py");
const PROBE_SRC = readFileSync(PROBE, "utf-8");
const SERVER_SRC = readFileSync(join(REPO_ROOT, "server.ts"), "utf-8");

const LIMIT =
  "This file runs the probe's pure --selftest only. It detects NO Claude CLI drift: hook payload " +
  "shapes, menu keys and M1/M5/M6 only change when the real CLI is replayed (TESTING.md, 'Sondes hors gate').";

function findPython(): string {
  for (const candidate of ["python3", "python", "py"]) {
    const bin = Bun.which(candidate);
    if (!bin) continue;
    const probe = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe", env: scrubEnv(SCRATCH) });
    if (probe.exitCode === 0) return bin;
  }
  throw new Error("no usable python interpreter on PATH (python3, python, py): the probe selftest cannot run");
}

function constant(name: string): string {
  const m = new RegExp(`^${name} = "([^"]+)"\\r?$`, "m").exec(PROBE_SRC);
  if (!m || !m[1]) throw new Error(`probe declares no \`${name} = "..."\` line: the cross-check below would pass on nothing`);
  return m[1];
}

test("probe --selftest passes on every check and covers the secret-leak and verdict guards", () => {
  const r = Bun.spawnSync([findPython(), PROBE, "--selftest"], { stdout: "pipe", stderr: "pipe", env: scrubEnv(SCRATCH) });
  const out = r.stdout.toString();
  const failed = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
  expect(failed, `failing selftest checks. ${LIMIT}\n${out}\n${r.stderr.toString()}`).toEqual([]);
  expect(r.exitCode, `selftest exit code. ${LIMIT}\n${out}\n${r.stderr.toString()}`).toBe(0);
  for (const mode of ["hooks", "redirect", "type"]) {
    expect(out, `no secret-leak check for mode ${mode}: a selftest with no checks would pass vacuously`).toContain(
      `ok workdir files for ${mode} never contain the secret`,
    );
  }
  for (const guard of [
    "scrub redacts the secret",
    "scrub redacts a 34-char fragment of the secret",
    "report never prints a fragment cut by the payload or screen truncation",
    "hooks: missing PermissionRequest fails",
    "type 2: Alpha fails (M5)",
    "type: keys with no expectation are inconclusive, never a pass",
    "inside_repo refuses a not yet created path under the repository",
  ]) {
    expect(out, `selftest lost the check "${guard}". ${LIMIT}`).toContain(`ok ${guard}`);
  }
});

test("the tool the probe tells the agent to call is the one server.ts registers", () => {
  const serverName = constant("MCP_SERVER");
  const toolName = constant("MCP_TOOL");
  expect(
    new RegExp(`name: "${serverName}"`).test(SERVER_SRC),
    `server.ts no longer names its MCP server "${serverName}": the probe's redirect reason cites a tool that does not exist (an absent tool makes the agent refuse the redirect)`,
  ).toBe(true);
  expect(
    new RegExp(`name: "${toolName}"`).test(SERVER_SRC),
    `server.ts registers no tool "${toolName}": the probe's deny reason points at nothing`,
  ).toBe(true);
});
