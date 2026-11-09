import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { DECK_ONLY_TOOLS } from "../shared/peers-session.ts";
import { OPERATOR_CEILING_ENV, OPERATOR_TOOLS, resolveMountCeiling } from "../shared/mount-ceiling.ts";
import { deckLeadScriptPath, writeSupervisorMcpConfig } from "../desktop/src/main/supervisor.ts";
import { scrubEnv } from "./_scrub-env.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "probe-auq-test-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROBE = join(REPO_ROOT, "scripts", "probe-askuserquestion-hooks.py");
// The probe is Python: its constants cannot be imported, only read.
const PROBE_SRC = readFileSync(PROBE, "utf-8");

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

test("the MCP server the probe names is mounted by the Deck with a ceiling that grants the tool the probe tells the agent to call", () => {
  const server = constant("MCP_SERVER");
  const tool = constant("MCP_TOOL");
  const mcpScriptPath = join(SCRATCH, "deck-plugin", "mcp", "deck-control-mcp.mjs");
  const file = writeSupervisorMcpConfig({
    dir: SCRATCH,
    mcpScriptPath,
    execPath: process.execPath,
    controlUrl: "http://127.0.0.1:1",
    controlToken: "unused",
  });
  const mcpServers = (JSON.parse(readFileSync(file, "utf-8")) as {
    mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
  }).mcpServers;
  const mounted = mcpServers[server];
  expect(
    mounted,
    `the Deck mounts no MCP server "${server}" (mounted: ${Object.keys(mcpServers).join(", ")}): mcp__${server}__${tool} does not exist`,
  ).toBeDefined();
  expect(mounted!.args, `"${server}" does not launch the operator-family script`).toEqual([deckLeadScriptPath(mcpScriptPath)]);
  const ceiling = resolveMountCeiling(OPERATOR_CEILING_ENV, mounted!.env[OPERATOR_CEILING_ENV], OPERATOR_TOOLS);
  expect(ceiling.ok, `the "${server}" mount ceiling is refused by the server's own resolver`).toBe(true);
  expect(ceiling.ok ? ceiling.value : [], `"${server}" is mounted without "${tool}" in its ceiling`).toContain(tool);
  expect(
    DECK_ONLY_TOOLS.map((declared) => declared.name),
    `the operator family declares no "${tool}": the "${server}" process has nothing to serve under it`,
  ).toContain(tool);
});
