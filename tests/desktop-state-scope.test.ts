// Discipline guard: every file name the Deck's main process writes under its
// state dir (userData/config) is classified with a scope and a reason, and
// every SESSION-scoped file is reached through sessions/<groupId>/. Two Kory
// windows share userData: a session-scoped file written at the root carries no
// key and is read by both windows, so the absence of a key is a leak, not a
// default. The audit is a pure function (tests/_state-scope-audit.ts) run on
// the real tree AND on synthetic mutations below, so the proof that it bites
// is replayed on every run rather than measured once and left out.
//
// Coverage of the guard itself is audited here, not only its sensitivity:
// literal scanning fails OPEN on a computed name, so constructor functions are
// classified by name and an unattributable template is a finding; the
// classification table fails CLOSED on a stale entry; and inbox-store.ts's
// export list is checked against the wiring rules so a new accessor cannot
// appear without being wired.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  auditStateScopes,
  formatFindings,
  type AccessorBinding,
  type NotAppStateRule,
  type StateFileRule,
  type WiringRule,
} from "./_state-scope-audit";
import { inboxAckFile, inboxHistoryFile } from "../desktop/src/main/inbox-store";
import { SESSION_STATE_SUBDIR, sessionStateDir } from "../desktop/src/main/session-state";

const REPO_ROOT = join(import.meta.dir, "..");
const MAIN_DIR = join(REPO_ROOT, "desktop", "src", "main");
/** sessionStateDir builds the path; createSessionDirAccessor wraps it in the closable gate index.ts uses. */
const SESSION_DIR_BUILDERS = ["sessionStateDir", "createSessionDirAccessor"] as const;
const SESSION_DIR_BUILDER = SESSION_DIR_BUILDERS[0];
/** A classification without a motive is not a decision. */
const MIN_REASON_CHARS = 40;

// ----- the table -----

const INBOX_STORE_WIRING: readonly WiringRule[] = [
  { callee: "inboxHistoryFile", dirArg: 0 },
  { callee: "loadInboxHistory", dirArg: 0 },
  { callee: "appendInboxHistory", dirArg: 0 },
  { callee: "clearInboxHistory", dirArg: 0 },
  { callee: "deleteInboxHistoryEntries", dirArg: 0 },
  { callee: "inboxAckFile", dirArg: 0 },
  { callee: "loadAckState", dirArg: 0 },
  { callee: "loadAckStateWithMigrationSeed", dirArg: 0 },
  { callee: "appendSeenKey", dirArg: 0 },
  { callee: "appendAckedKey", dirArg: 0 },
];

/** inbox-store.ts exports that take the state ROOT on purpose, with the motive. */
const INBOX_STORE_ROOT_ACCESSORS: Record<string, string> = {
  discardUnscopedInboxFiles:
    "removes the unkeyed files an earlier layout wrote at the root; it must address the root to find them",
};

const STATE_SCOPES: Record<string, StateFileRule> = {
  // ----- SESSION: what this window lived through, keyed by group_id, gone with the window -----
  "inbox-history.json": {
    kind: "literal",
    scope: "session",
    module: "inbox-store.ts",
    wiring: INBOX_STORE_WIRING,
    reason:
      "operator-inbox journal: messages agents of THIS group sent the operator; read by another window it shows another repo's notifications",
  },
  "inbox-ack.json": {
    kind: "literal",
    scope: "session",
    module: "inbox-store.ts",
    wiring: INBOX_STORE_WIRING,
    reason: "read-state of the inbox entries above; shared, an ack in one window marks the entry read in the other",
  },
  "supervisor-mcp.json": {
    kind: "literal",
    scope: "session",
    module: "supervisor.ts",
    wiring: [{ callee: "writeSupervisorMcpConfig", dirArg: { prop: "dir" } }],
    reason:
      "carries THIS window's deck-control URL and token; at the root two windows overwrite each other and a supervisor could pilot the wrong Deck",
  },
  "demo-mcp.json": {
    kind: "literal",
    scope: "session",
    module: "demo-driver.ts",
    wiring: [{ callee: "writeDemoMcpConfig", dirArg: { prop: "dir" } }],
    reason: "per-run demo-control URL and token of this window's embedded browser; same swap hazard as supervisor-mcp.json",
  },
  ttsrEffectiveFileName: {
    kind: "constructor",
    scope: "session",
    module: "ttsr-service.ts",
    wiring: [{ callee: "TtsrService", dirArg: { prop: "sessionDir" } }],
    reason:
      "compiled guard rules of one tile (<desk id>.json under ttsr/): a restored workspace reuses desk ids, so at the root two windows would overwrite each other's rules",
  },
  "demo-scenario.md": {
    kind: "literal",
    scope: "session",
    module: "demo-driver.ts",
    wiring: [{ callee: "writeDemoScenarioFile", dirArg: 0 }],
    reason: "the operator's scenario text for this window's demo run; two concurrent demos at the root would swap scenarios",
  },

  // ----- PROJECT: belongs to the repository, whatever the window -----
  "review-pending.json": {
    kind: "literal",
    scope: "project",
    reason: "pending diff review, one map keyed by project_key; a review belongs to the repo and is worth finding after a restart",
  },
  "approvals.json": {
    kind: "literal",
    scope: "project",
    reason: "remote-approval opt-out per project_key (a project restricts, never enables); same for every window on the repo",
  },
  "launch-approvals.json": {
    kind: "literal",
    scope: "project",
    reason: "operator-approved repo-sourced launch commands, sha256 per project_key; the trust decision follows the repo",
  },
  "ttsr-approvals.json": {
    kind: "literal",
    scope: "project",
    reason: "operator-approved repo guard-rule files, a set of sha256 per project_key; the trust decision follows the repo, every window on it shares it",
  },
  ttsrSandboxCopyName: {
    kind: "constructor",
    scope: "project",
    reason: "ttsr-<session uuid>.json in the project container's run dir, a copy of a tile's rules; the uuid is minted per spawn, so two windows on one container never share one",
  },
  "sandbox.json": {
    kind: "literal",
    scope: "project",
    reason: "sandbox toggle and container state per project_key; the container itself is per project, so is its record",
  },
  "session-approval.json": {
    kind: "literal",
    scope: "project",
    reason: "suffix of the per-window agent credential file, prefixed by approvalCredFileName with the project-derived instance token",
  },
  approvalCredFileName: {
    kind: "constructor",
    scope: "project",
    reason: "builds <instanceToken(project_key)>-session-approval.json; the residual worktree collision is documented in the function",
  },
  teamLeadMcpConfigFileName: {
    kind: "constructor",
    scope: "project",
    reason: "team-lead-mcp-<instanceToken(project_key)>-<callerId>.json, swept at startup by the same prefix; accumulation between two windows of one repo is accepted",
  },
  graphsFile: {
    kind: "constructor",
    scope: "project",
    reason: "graphs/graphs-<sha256(project_key)[:16]>.json: graph documents belong to the repo, both windows on it share them by design",
  },
  writeSnippet: {
    kind: "constructor",
    scope: "project",
    reason: "<safeName>.md under the project's or the global snippets dir; a reusable prompt is content, not a window's state",
  },
  writeTemplate: {
    kind: "constructor",
    scope: "project",
    reason: "<safeName>.json under a templates dir (project-local or global); a template is content the operator exports, not window state",
  },
  workspacePath: {
    kind: "constructor",
    scope: "project",
    reason: "<projectDir>/.claude/claude-peers/workspaces/<id>.json: workspaces live in the repo, outside userData, project by construction",
  },
  deleteWorkspace: {
    kind: "constructor",
    scope: "project",
    reason: "removes the workspace JSON and its <id>.lock sidecar, same repo-local dir as workspacePath",
  },
  lockPath: {
    kind: "constructor",
    scope: "project",
    reason: "<id>.lock next to a workspace JSON (workspace-lock.ts) and <config.json>.lock (peers-config-store.ts): sidecars of the file they guard",
  },

  // ----- MACHINE: belongs to the operator and the workstation -----
  "config.json": {
    kind: "literal",
    scope: "machine",
    reason: "app settings under userData/config (store.ts), protected by the inter-process file lock; the same name also names the launch config and a repo's peers config, which are not app state",
  },
  "sessions.json": {
    kind: "literal",
    scope: "machine",
    reason: "legacy tile list, write-only (restore goes through workspaces); last-writer-wins without content leak, removal is an open question of the isolation brief",
  },
  "clodex-lifecycle.lock": {
    kind: "literal",
    scope: "machine",
    reason: "coordinates every Deck instance using the same per-profile CLODEX_HOME store, so lifecycle changes must serialize across windows",
  },
  "koryphaios-clodex-lifecycle.db": {
    kind: "literal",
    scope: "machine",
    reason: "the lease and owner store that lock guards, one per CLODEX_HOME; the Deck creates, names and writes it, unlike the clodex manifest sitting in the same directory",
  },
  "clodex-proxy.log": {
    kind: "literal",
    scope: "machine",
    reason: "output of the proxy the Deck launches, appended under app.getPath('logs'); one operator and one workstation, and two windows appending to it interleave lines without leaking anything",
  },
  "ttsr-rules.json": {
    kind: "literal",
    scope: "machine",
    reason: "the operator's own guard rules under the global config dir, applied in every project; one operator, one file, polled by every window",
  },
  "operator.json": {
    kind: "literal",
    scope: "machine",
    reason: "the operator's Ed25519 identity, one per OS user by design; every window signs as the same operator",
  },
  "companion-cert.json": {
    kind: "literal",
    scope: "machine",
    reason: "self-signed certificate of the LAN companion server; two windows opening the companion contend for the port, out of scope here",
  },
  "scope-secrets.json": {
    kind: "literal",
    scope: "machine",
    reason: "encrypted custom-scope secrets, a map keyed by group_id that must OUTLIVE the session to rejoin a group; it exempts nothing from the session sweep",
  },
  "supervisor-system-prompt.md": {
    kind: "literal",
    scope: "machine",
    reason: "rendered from a code constant plus the docs dir, identical for every window; last-writer-wins on identical content is harmless",
  },
  "demo-system-prompt.md": {
    kind: "literal",
    scope: "machine",
    reason: "rendered from a code constant, identical for every window; last-writer-wins on identical content is harmless",
  },
  "browser:save-annotation": {
    kind: "constructor",
    scope: "machine",
    reason: "annotations/annotation-<stamp>.png: a shared screenshot pool pruned after 7 days, reachable only through the project-scoped review that references it",
  },
  writeEmbeddedAgentPrompt: {
    kind: "constructor",
    scope: "machine",
    reason: "embedded-agent-<id>.md rendered from a code constant, identical for every window; last-writer-wins on identical content",
  },
  writeContextFile: {
    kind: "constructor",
    scope: "machine",
    reason: "graph-context-<nodeId>-<cli>.md, a transient headless-inference input; two windows running the same utility kind at once can collide, a loss never a leak",
  },
  createRollingLogger: {
    kind: "constructor",
    scope: "machine",
    reason: "<name>.log under app.getPath('logs'), the size-rotated main log; one operator, one workstation, one log",
  },
  tempFileName: {
    kind: "constructor",
    scope: "machine",
    reason: "<file>.<pid>.<random>.tmp, the atomic-write sibling of whatever file is being replaced; keyed by pid AND call so two processes never share one",
  },
  storePath: {
    kind: "constructor",
    scope: "machine",
    reason: "builds <clodexHome(env)>/koryphaios-clodex-lifecycle.db; every window sharing one CLODEX_HOME must serialize on the same store, so the name is deliberately not keyed by window",
  },
};

/** Names the scan sees that are NOT files under the Deck's state dir, each with its motive. */
const NOT_APP_STATE: Record<string, NotAppStateRule> = {
  ".mcp.json": { reason: "a repo's own MCP config, read to project it into the sandbox; never written under userData" },
  ".claude.json": { reason: "Claude Code's home config, read to locate the MCP entry's server script; never written by the Deck" },
  ".credentials.json": { reason: "Claude Code's OAuth credential file under ~/.claude, read for the usage gauge; never written" },
  "auth.json": { reason: "Codex CLI's credential file under its home, read for the usage gauge; never written" },
  "settings.json": { reason: "Claude Code settings (host ~/.claude or the sandbox copy), a projection SOURCE, never Deck state" },
  "CLAUDE.md": { reason: "repo instructions listed as a sandbox projection source; never written by the Deck" },
  "deck-journal.txt": { reason: "default file name of the journal EXPORT save dialog, written where the operator chooses" },
  containerPath: { reason: "container-side path of the sandbox prompt file (/kory-run), a mount target, not userData" },
  composeSandboxAppendPrompt: { reason: "prompt-<sessionId>.txt under the sandbox run dir on the host, per session uuid, outside the state dir" },
  deskSessionFileName: { reason: "desk-session-<token>.txt under ~/.claude/peers, the peer-id cache shared with the CLI; mirrors shared/peer-cache.ts" },
  resolvePeerId: { reason: "reads peer-id-<cwd>-<session>.txt from ~/.claude/peers, the CLI's own cache; keyed by cwd and CC session" },
  peerIdCacheFileName: { reason: "builds the same peer-id-<cwd>-<session>.txt name for resolvePeerIdAmong, the CLI's own cache under ~/.claude/peers; never Deck state" },
  SANDBOX_CREDENTIALS_FILE: { reason: "container-side path constant (/home/.../.claude/.credentials.json), never a host file" },
  SANDBOX_CLAUDE_JSON: { reason: "container-side path constant of .claude.json, never a host file" },
  buildAuthProbeArgs: { reason: "shell probe run INSIDE the container interpolating the two constants above; writes nothing" },
  availableLocales: { reason: "<code>.json locale bundles shipped with the app, read-only" },
  readDictFile: { reason: "<lang>.json locale bundle read from the app's locales dir, read-only" },
  transcriptPath: { reason: "~/.claude/projects/<cwd>/<id>.jsonl, Claude Code's own transcript, read for the resume digest" },
  "rules.json": { reason: "a repository's guard rules under .claude/claude-peers, read as hostile repo content and written only on an explicit operator save; never under userData" },
  "serve.json": { reason: "a cloned repository's serve convention under .claude/claude-peers; its name is imposed by the project and the Deck only reads it" },
  "patch-state.json": { reason: "clodex's own manifest under its home (CLODEX_HOME or ~/.clodex), written by `clodex patch`; the Deck only reads it for patch freshness" },
  "server-runtime.json": { reason: "clodex's record of its live servers under the same home, written by `clodex server`; the Deck only reads it to adopt a proxy or to prove the identity of one it owns" },
  runtimePath: { reason: "builds the path of that clodex manifest under its home; the Deck writes nothing there, its own lifecycle records live in the SQLite store keyed by clodex-lifecycle.*" },
  readRuntime: { reason: "interpolates the manifest name into two error traces, which are messages and never paths; the read itself addresses the file through runtimePath" },
};

/** index.ts hands the per-group dir builder to ipc.ts through the deps object. */
const ACCESSOR_BINDINGS: readonly AccessorBinding[] = [{ file: "index.ts", callee: "registerIpc", prop: SESSION_DIR_BUILDER }];

// ----- sources -----

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function realSources(): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const f of walk(MAIN_DIR)) sources[relative(MAIN_DIR, f).split(sep).join("/")] = readFileSync(f, "utf-8");
  return sources;
}

const REAL_INPUT = {
  sources: realSources(),
  stateScopes: STATE_SCOPES,
  notAppState: NOT_APP_STATE,
  sessionDirBuilders: SESSION_DIR_BUILDERS,
  accessorBindings: ACCESSOR_BINDINGS,
};

// ----- the guard on the real tree -----

test("every state file name under desktop/src/main is classified, and every session file is reached through sessions/<groupId>/", () => {
  const findings = auditStateScopes(REAL_INPUT);
  expect(
    findings,
    `state-scope audit findings (classify the name in STATE_SCOPES with a scope and a reason, or in NOT_APP_STATE; a session file must be written under ${SESSION_DIR_BUILDER}(...)):\n${formatFindings(findings)}`
  ).toEqual([]);
});

test("every classification carries a reason of at least " + MIN_REASON_CHARS + " characters", () => {
  const short = [
    ...Object.entries(STATE_SCOPES).filter(([, r]) => r.reason.trim().length < MIN_REASON_CHARS),
    ...Object.entries(NOT_APP_STATE).filter(([, r]) => r.reason.trim().length < MIN_REASON_CHARS),
    ...Object.entries(INBOX_STORE_ROOT_ACCESSORS).filter(([, r]) => r.trim().length < MIN_REASON_CHARS),
  ].map(([name]) => name);
  expect(short, "a classification without a motive is not a decision").toEqual([]);
});

test("a session-scoped rule names its module and at least one wiring rule (a session file nobody wires is unguarded)", () => {
  const bare = Object.entries(STATE_SCOPES)
    .filter(([, r]) => r.scope === "session" && (!r.module || !r.wiring || r.wiring.length === 0))
    .map(([name]) => name);
  expect(bare).toEqual([]);
});

test("the real sources include the modules the session rules exclude from their own wiring scan", () => {
  const files = new Set(Object.keys(REAL_INPUT.sources));
  for (const [name, rule] of Object.entries(STATE_SCOPES)) {
    if (rule.module) expect(files.has(rule.module), `${name}: module ${rule.module} must exist under desktop/src/main`).toBe(true);
  }
});

// ----- rule 3, on the constructed path -----

test("the session file paths are built under <stateDir>/sessions/<groupId>/, checked on the path, not the name", () => {
  const root = join("/state");
  const gid = "f".repeat(32);
  const prefix = join(root, SESSION_STATE_SUBDIR, gid) + sep;
  for (const built of [inboxHistoryFile(sessionStateDir(root, gid)), inboxAckFile(sessionStateDir(root, gid))]) {
    expect(built.startsWith(prefix), `${built} must start with ${prefix}`).toBe(true);
  }
});

// ----- coverage of the guard itself -----

test("every inbox-store.ts export taking a directory is either wired (sessionDir) or a root accessor with a motive", () => {
  const src = REAL_INPUT.sources["inbox-store.ts"]!;
  const exportRe = /export function ([A-Za-z_$][\w$]*)\s*\(\s*\n?\s*([A-Za-z_$][\w$]*)\s*:\s*string/g;
  const wired = new Set(INBOX_STORE_WIRING.map((w) => w.callee));
  const seen: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(src)) !== null) {
    const [, fn, param] = m;
    seen.push(fn!);
    if (param === "sessionDir") {
      expect(wired.has(fn!), `${fn}(sessionDir) is a session accessor and must be in INBOX_STORE_WIRING`).toBe(true);
    } else if (param === "stateDir") {
      expect(fn! in INBOX_STORE_ROOT_ACCESSORS, `${fn}(stateDir) addresses the root and must be listed with a motive`).toBe(true);
    } else {
      throw new Error(`${fn}: first parameter ${param} is neither sessionDir nor stateDir -- name the directory it takes`);
    }
  }
  expect(seen.length, "the export scan must see the inbox-store accessors").toBeGreaterThanOrEqual(INBOX_STORE_WIRING.length);
  for (const w of INBOX_STORE_WIRING) expect(seen, `wiring rule ${w.callee} must name a real export`).toContain(w.callee);
});

test("the literal scan sees a known-computed name only through its constructor (the fail-open direction is covered by attribution)", () => {
  // approvalCredFileName's template interpolates CRED_FILE and carries no
  // extension of its own: it is caught by the FILE-identifier rule, not by
  // the extension tail. Both routes must stay alive.
  const findings = auditStateScopes({
    ...REAL_INPUT,
    stateScopes: Object.fromEntries(Object.entries(STATE_SCOPES).filter(([n]) => n !== "approvalCredFileName")),
  });
  expect(findings.map((f) => `${f.kind}:${f.detail.split(" ")[0]}`)).toContain("unclassified-constructor:approvalCredFileName");
});

// ----- in-diff proof that the guard bites (replayed on every run) -----

const MUTATION_BASE = {
  stateScopes: STATE_SCOPES,
  notAppState: NOT_APP_STATE,
  sessionDirBuilders: SESSION_DIR_BUILDERS,
};

/** Findings other than the stale-rule noise a tiny synthetic tree necessarily produces. */
function liveFindings(sources: Record<string, string>) {
  return auditStateScopes({ ...MUTATION_BASE, sources }).filter((f) => f.kind !== "stale-rule");
}

test("mutation: a new unclassified file name written under the state dir turns the guard red", () => {
  const findings = liveFindings({
    "new-store.ts": "const FILE = 'brand-new-thing.json'\nexport function f(stateDir: string) { return join(stateDir, FILE) }\n",
  });
  expect(findings.map((f) => [f.kind, f.detail])).toEqual([["unclassified-literal", "brand-new-thing.json"]]);
});

test("mutation: a session file reached through the bare state root turns the guard red", () => {
  const findings = liveFindings({
    "index.ts": "appendInboxHistory(join(app.getPath('userData'), APP_STATE_SUBDIR), toPersist)\n",
  });
  expect(findings.map((f) => f.kind)).toEqual(["unwired-session-call"]);
  expect(findings[0]!.detail).toContain("appendInboxHistory (inbox-history.json, inbox-ack.json)");
});

test("mutation: a session file reached through an identifier with one non-session binding turns the guard red (ambiguity fails closed)", () => {
  const findings = liveFindings({
    "ipc.ts": [
      "const stateDir = join(app.getPath('userData'), APP_STATE_SUBDIR)",
      "const stateDir = sessionStateDir(root, gid)",
      "loadInboxHistory(stateDir)",
    ].join("\n"),
  });
  expect(findings.map((f) => f.kind)).toEqual(["unwired-session-call"]);
});

test("mutation: an object-argument dir (supervisor-mcp.json) reached through the root turns the guard red", () => {
  const findings = liveFindings({
    "index.ts": "writeSupervisorMcpConfig({ dir: join(app.getPath('userData'), APP_STATE_SUBDIR), mcpScriptPath: x })\n",
  });
  expect(findings.map((f) => f.kind)).toEqual(["unwired-session-call"]);
});

test("mutation: a new unclassified name constructor (a computed file name) turns the guard red", () => {
  const findings = liveFindings({
    "thing.ts": "export function thingFileName(id: string): string {\n  return `thing-${id}.json`\n}\n",
  });
  expect(findings.map((f) => [f.kind, f.detail])).toEqual([["unclassified-constructor", "thingFileName builds `thing-${id}.json`"]]);
});

test("mutation: a computed name that no declaration can be attributed to is a finding, never dropped", () => {
  const findings = liveFindings({ "loose.ts": "writeFileSync(join(dir, `loose-${id}.json`), '')\n" });
  expect(findings.map((f) => f.kind)).toEqual(["unattributed-template"]);
});

test("mutation: a classified session file written by a SECOND module, bypassing its accessors, turns the guard red", () => {
  const findings = liveFindings({
    "leak.ts": "export function dumpInbox(stateDir: string, data: string) { writeFileSync(join(stateDir, 'inbox-history.json'), data) }\n",
  });
  expect(findings.map((f) => [f.kind, f.detail])).toEqual([["session-literal-outside-module", "inbox-history.json is owned by inbox-store.ts"]]);
});

test("mutation: a classified session file with its callers correctly wired is clean", () => {
  const findings = liveFindings({
    "index.ts": [
      "const sessionDir = createSessionDirAccessor({ stateDir: appStateDir, groupId: () => activeScope.groupId })",
      "appendInboxHistory(sessionDir(), toPersist)",
      "writeSupervisorMcpConfig({ dir: sessionDir(), mcpScriptPath: x })",
      "registerIpc({ service, sessionStateDir: sessionDir })",
    ].join("\n"),
    "ipc.ts": "regHandle('inbox:history', () => loadInboxHistory(sessionStateDir()))\n",
  });
  expect(findings).toEqual([]);
});

test("mutation: the deps object handing the builder to ipc.ts is checked too (a root binding there turns the guard red)", () => {
  const findings = auditStateScopes({
    ...MUTATION_BASE,
    sources: { "index.ts": "registerIpc({ service, sessionStateDir: () => join(app.getPath('userData'), APP_STATE_SUBDIR) })\n" },
    accessorBindings: ACCESSOR_BINDINGS,
  }).filter((f) => f.kind !== "stale-rule");
  expect(findings.map((f) => f.kind)).toEqual(["unbound-accessor"]);
});

test("mutation: a stale classification (a name nothing in the tree uses) turns the guard red", () => {
  const findings = auditStateScopes({
    ...REAL_INPUT,
    stateScopes: { ...STATE_SCOPES, "ghost.json": { kind: "literal", scope: "machine", reason: "a file that does not exist anywhere in the tree" } },
  });
  expect(findings.map((f) => [f.kind, f.detail])).toEqual([["stale-rule", "ghost.json (literal) matched nothing"]]);
});

test("mutation: a file name inside a comment is not a finding (the scan reads code, not prose)", () => {
  const findings = liveFindings({ "doc.ts": "// see brand-new-thing.json for the format\n/* and `ghost-${id}.json` */\nexport const x = 1\n" });
  expect(findings).toEqual([]);
});
