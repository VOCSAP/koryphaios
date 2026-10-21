// Blobs are read at the commit, never from the clone's worktree: a dirty clone must not leak into the copy.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isDistributable, isEnginePath, modsFingerprint, PLUGIN_NAME_PATTERN, type ModFile } from "../shared/mods-fingerprint";

export const PLUGINS = ["prosopon"] as const;
export const CHOREGOS_REPO = "https://github.com/VOCSAP/choregos";
export const MODS_DIR = join(import.meta.dir, "..", "desktop", "mods");
export const LOCK_PATH = join(MODS_DIR, "choregos.lock.json");

export interface ModsLock {
  repo: string;
  commit: string;
  plugins: Record<string, { version: string; fingerprint: string }>;
}

// Wider than bun's own discovery rule on purpose: a file bun would collect from
// desktop/mods/ under a bare `bun test` imports claude-code/testing and fails.
export function isBunTestFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /[._](test|spec)[._]/i.test(name);
}

function git(repo: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${repo}: ${result.stderr?.toString().trim() || result.error?.message || `exit ${result.status}`}`);
  }
  return result.stdout;
}

const FORBIDDEN_SEGMENTS = new Set([".git", ".gitattributes", ".gitmodules", "..", "."]);

export function readPluginAtCommit(repo: string, commit: string, plugin: string): ModFile[] {
  if (!PLUGIN_NAME_PATTERN.test(plugin)) throw new Error(`plugin name '${plugin}' does not match ${PLUGIN_NAME_PATTERN}`);
  const prefix = `plugins/${plugin}/`;
  const listing = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", prefix]).toString("utf-8");
  const selected: { path: string; oid: string }[] = [];
  for (const entry of listing.split("\0").filter((line) => line.length > 0)) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (!match) throw new Error(`unparseable git ls-tree entry: ${entry}`);
    const [, mode, type, oid, fullPath] = match as unknown as [string, string, string, string, string];
    const path = fullPath.slice(prefix.length);
    if (path.includes("\\")) throw new Error(`${fullPath}: a backslash in a path is refused`);
    const forbidden = path.split("/").find((segment) => segment === "" || FORBIDDEN_SEGMENTS.has(segment));
    if (forbidden !== undefined) throw new Error(`${fullPath}: the path segment '${forbidden}' is refused`);
    if (path.startsWith("tests/")) continue;
    if (isEnginePath(path)) throw new Error(`${fullPath}: a path the engine writes into a plugin directory is never distributed`);
    if (isBunTestFile(path)) throw new Error(`${fullPath}: a test file outside tests/ would be collected by a bare bun test`);
    if (!isDistributable(path)) throw new Error(`${fullPath}: only .claude-plugin/, hooks/ and README.md are distributable`);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`${fullPath}: only regular files can be copied, got ${type} ${mode}`);
    }
    selected.push({ path, oid });
  }
  if (selected.length === 0) throw new Error(`${prefix} is empty or absent at ${commit}`);
  const files: ModFile[] = selected.map(({ path, oid }) => ({ path, bytes: new Uint8Array(git(repo, ["cat-file", "blob", oid])) }));
  files.push({ path: "LICENSE", bytes: new Uint8Array(git(repo, ["show", `${commit}:LICENSE`])) });
  return files;
}

function pluginVersion(files: readonly ModFile[], plugin: string): string {
  const manifest = files.find((file) => file.path === ".claude-plugin/plugin.json");
  if (!manifest) throw new Error(`${plugin}: .claude-plugin/plugin.json is missing`);
  const version: unknown = JSON.parse(new TextDecoder().decode(manifest.bytes)).version;
  if (typeof version !== "string" || version.length === 0) throw new Error(`${plugin}: plugin.json has no version`);
  return version;
}

export function writePlugins(
  modsDir: string,
  plugins: readonly { plugin: string; files: readonly ModFile[] }[],
  rename: (from: string, to: string) => void = renameSync,
): void {
  const modsRoot = resolve(modsDir);
  const planned = plugins.map(({ plugin, files }) => {
    const root = resolve(modsRoot, plugin);
    if (!root.startsWith(modsRoot + sep)) throw new Error(`${plugin}: resolves outside ${modsRoot}`);
    const seen = new Set<string>();
    for (const file of files) {
      const target = resolve(root, file.path);
      if (!target.startsWith(root + sep)) throw new Error(`${plugin}/${file.path}: resolves outside ${root}`);
      // Windows and macOS file systems fold case, so two such names would overwrite each other.
      const canonical = target.normalize("NFC").toLowerCase();
      if (seen.has(canonical)) throw new Error(`${plugin}/${file.path}: collides with another file once case is folded`);
      seen.add(canonical);
    }
    return { plugin, files, root };
  });
  for (const { plugin, files, root } of planned) {
    const staging = join(modsRoot, `.${plugin}.staging-${process.pid}`);
    const retired = join(modsRoot, `.${plugin}.retired-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      for (const file of files) {
        const target = resolve(staging, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.bytes);
      }
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
    const hadRoot = existsSync(root);
    try {
      if (hadRoot) rename(root, retired);
      try {
        rename(staging, root);
      } catch (error) {
        if (hadRoot) {
          try {
            rename(retired, root);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              `${plugin}: swapping the copy in failed (${String(error)}) and restoring the previous copy failed too (${String(rollbackError)}); it is left in ${retired}`,
            );
          }
        }
        throw error;
      }
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    rmSync(retired, { recursive: true, force: true });
  }
}

export function parseArgs(argv: string[]): { repo: string; commit: string } {
  let repo: string | undefined;
  let commit: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i];
    else if (arg === "--commit") commit = argv[++i];
    else throw new Error(`unknown argument: ${arg} (usage: --repo <choregos clone> --commit <sha>)`);
  }
  if (!repo || !commit) throw new Error("usage: --repo <choregos clone> --commit <sha>");
  return { repo, commit };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const commit = git(args.repo, ["rev-parse", "--verify", `${args.commit}^{commit}`]).toString("utf-8").trim();
  const lock: ModsLock = { repo: CHOREGOS_REPO, commit, plugins: {} };
  const read = PLUGINS.map((plugin) => ({ plugin, files: readPluginAtCommit(args.repo, commit, plugin) }));
  for (const { plugin, files } of read) {
    lock.plugins[plugin] = { version: pluginVersion(files, plugin), fingerprint: modsFingerprint(files) };
  }
  writePlugins(MODS_DIR, read);
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`synced ${PLUGINS.join(", ")} at ${commit}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
