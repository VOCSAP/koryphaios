import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..");
const ELECTRON_PACKAGE = join(REPO, "desktop", "node_modules", "electron");
// path.txt, not require: a mock.module("electron") in the same bun test
// process would be returned instead of the path; it also covers darwin's Electron.app layout.
// Called inside each test, not at module load: a throw here at load time would
// kill every test() in the file before bun even registers them, so a missing
// binary would report as ZERO tests instead of named failures.
function electronBinary(): string {
  const pointer = join(ELECTRON_PACKAGE, "path.txt");
  expect(existsSync(pointer), `electron is not installed: ${pointer} is missing`).toBe(true);
  return join(ELECTRON_PACKAGE, "dist", readFileSync(pointer, "utf-8").trim());
}
const SOURCE = join(REPO, "desktop", "src", "main", "clodex-lifecycle-io.ts");
const PROBE = join(import.meta.dir, "clodex-lifecycle-io-probe.cjs");
const TSC = join(REPO, "desktop", "node_modules", "typescript", "bin", "tsc");
const TYPE_ROOTS = join(REPO, "desktop", "node_modules", "@types");

async function buildAdapter(): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), "clodex-lifecycle-io-"));
  const result = await Bun.build({
    entrypoints: [SOURCE],
    outdir: dir,
    target: "node",
    format: "cjs",
    external: ["node:sqlite"],
  });

  expect(result.success).toBe(true);
  return { dir, file: join(dir, "clodex-lifecycle-io.js") };
}

function runProbe(bundle: string, args: string[]) {
  const result = spawnSync(electronBinary(), [PROBE, bundle, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf-8",
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

function runProbeAsync(bundle: string, args: string[]) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(electronBinary(), [PROBE, bundle, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`SQLite probe exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

function typecheckFactory() {
  const dir = mkdtempSync(join(tmpdir(), "clodex-lifecycle-io-typecheck-"));
  // A path mapping to SOURCE's own absolute path, not a relative() computed
  // from dir: relative() returns an unusable absolute path when dir and
  // SOURCE sit on different Windows drives (temp on C:, repo on D:), and on
  // macOS tmpdir()'s /var/folders symlink to /private/var/folders makes a
  // relative() count of ".." wrong once tsc resolves it through the real,
  // deeper path. An absolute paths[] target sidesteps both: no relative
  // math, no drive letter, no symlink depth to get right.
  writeFileSync(join(dir, "probe.ts"), [
    'import { DatabaseSync } from "node:sqlite";',
    'import { createSqliteRecordStore } from "clodex-lifecycle-io";',
    'createSqliteRecordStore(new DatabaseSync(":memory:"));',
  ].join("\n"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ["node"],
      typeRoots: [TYPE_ROOTS],
      baseUrl: ".",
      paths: { "clodex-lifecycle-io": [SOURCE.replaceAll("\\", "/")] },
    },
    files: ["probe.ts"],
  }));
  const result = spawnSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf-8" });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("SQLite records serialize values canonically and reject invalid stored JSON", async () => {
  electronBinary();
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["round-trip", database])).toEqual({
      serialized: '{"a":1,"b":2}',
      read: { a: 1, b: 2 },
      listed: [{ id: 1 }, { id: 2 }],
      removed: null,
      invalidReadRejected: true,
      nonCanonicalReadRejected: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite records apply busyTimeoutMs to the real DatabaseSync", async () => {
  electronBinary();
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["busy-timeout", database])).toEqual({ busyTimeoutMs: 73 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite records reject sparse arrays before writing", async () => {
  electronBinary();
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["sparse-arrays", database])).toEqual({
      emptySlotRejected: true,
      leadingSlotRejected: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DatabaseSync satisfies the injected SQLite connection contract", () => {
  const result = typecheckFactory();
  expect({ status: result.status, output: `${result.stdout}${result.stderr}` }).toEqual({ status: 0, output: "" });
});

test("two Electron processes share exactly one successful createExclusive", async () => {
  electronBinary();
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    runProbe(file, ["prepare", database]);
    const results = await Promise.all([
      runProbeAsync(file, ["create", database, "lease", '{"pid":1}']),
      runProbeAsync(file, ["create", database, "lease", '{"pid":2}']),
    ]);
    expect(results.map((result) => (result as { created: number }).created).sort()).toEqual([0, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conditional deletion preserves a replacement and timed contention preserves the value", async () => {
  electronBinary();
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["replacement", database])).toEqual({
      removed: false,
      remaining: { generation: "replacement" },
    });
    expect(runProbe(file, ["contention", database])).toEqual({
      rejected: true,
      remaining: { generation: "original" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
