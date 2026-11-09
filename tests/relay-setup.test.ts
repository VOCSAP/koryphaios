import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imported dynamically, with a harmless argv, to measure what the import itself does:
// an unguarded main() would print here (and would build the relay without --print-only).
const realLog = console.log;
const printed: string[] = [];
const realArgv = process.argv;
const realExitCode = process.exitCode;
console.log = (...a: unknown[]) => void printed.push(a.join(" "));
process.argv = [realArgv[0] ?? "bun", "relay-setup.ts", "--print-only"];
const setup = await import("../scripts/relay-setup.ts");
console.log = realLog;
process.argv = realArgv;
const exitCodeAfterImport = process.exitCode;
process.exitCode = realExitCode;

const {
  binaryName,
  buildRelay,
  builtBinaryPath,
  cargoArgs,
  cargoTarget,
  chooseForm,
  installBinary,
  installedBinaryPath,
  isOlderThanSources,
  main,
  mcpAddCommands,
  platformDir,
  shellQuote,
} = setup;
type Fs = import("../scripts/relay-setup.ts").Fs;
type Deps = import("../scripts/relay-setup.ts").Deps;

const work = mkdtempSync(join(tmpdir(), "kory-relay-setup-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ROOT = "/home/op/koryphaios";
const INSTALLED = `${ROOT}/bin/linux-x64/claude-peers-relay`;
const BUILT = `${ROOT}/relay/target/x86_64-unknown-linux-musl/release/claude-peers-relay`;

type Failure = (op: string, from: string, to?: string) => boolean;

// In-memory file system: a map of path to size, an operation log, and a hook that
// refuses chosen operations the way a locked image or a missing file would.
function memFs(initial: Record<string, number> = {}, refuse: Failure = () => false) {
  const files = new Map<string, number>(Object.entries(initial));
  const log: string[] = [];
  const guard = (op: string, from: string, to?: string) => {
    if (refuse(op, from, to)) throw new Error(`${op} refused: ${to ?? from}`);
  };
  const fs: Fs = {
    exists: (p) => files.has(p),
    mkdir: (p) => void log.push(`mkdir ${p}`),
    copy: (from, to) => {
      guard("copy", from, to);
      const size = files.get(from);
      if (size === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, size);
      log.push(`copy ${from} -> ${to}`);
    },
    rename: (from, to) => {
      guard("rename", from, to);
      const size = files.get(from);
      if (size === undefined) throw new Error(`no such file: ${from}`);
      files.delete(from);
      files.set(to, size);
      log.push(`rename ${from} -> ${to}`);
    },
    remove: (p) => {
      guard("remove", p);
      files.delete(p);
      log.push(`remove ${p}`);
    },
    size: (p) => files.get(p) ?? -1,
  };
  return { fs, files, log };
}

function fakeDeps(opts: { files?: Record<string, number>; refuse?: Failure; run?: Deps["run"]; mtimes?: Record<string, number>; sources?: string[] } = {}) {
  const mem = memFs(opts.files, opts.refuse);
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const mtimeCalls: string[] = [];
  const deps: Deps = {
    root: ROOT,
    platform: "linux",
    arch: "x64",
    fs: mem.fs,
    run:
      opts.run ??
      ((cmd) => {
        ran.push(cmd);
        mem.files.set(BUILT, 11);
        return { exitCode: 0, stderr: "" };
      }),
    sourceFiles: () => opts.sources ?? [],
    mtimeMs: (p) => {
      mtimeCalls.push(p);
      return opts.mtimes?.[p] ?? 0;
    },
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
  };
  return { deps, out, err, ran, mem, mtimeCalls };
}

describe("importing the script", () => {
  test("starts nothing: no output, no exit code", () => {
    expect(printed, "removing the import.meta.main guard makes the import print the plan").toEqual([]);
    expect(exitCodeAfterImport, "removing the guard sets process.exitCode on import").toBe(realExitCode);
  });
});

describe("platform naming", () => {
  test("the directory is `${platform}-${arch}`", () => {
    expect([platformDir("win32", "x64"), platformDir("linux", "arm64"), platformDir("darwin", "arm64")], "dropping the arch or swapping the two parts changes every directory").toEqual([
      "win32-x64",
      "linux-arm64",
      "darwin-arm64",
    ]);
  });

  test("only win32 gets the .exe suffix", () => {
    expect([binaryName("win32"), binaryName("linux"), binaryName("darwin")], "adding .exe everywhere or nowhere breaks the path the config names").toEqual([
      "claude-peers-relay.exe",
      "claude-peers-relay",
      "claude-peers-relay",
    ]);
  });
});

describe("cargo invocation", () => {
  test("Linux builds the static musl target, other hosts and unknown Linux arches the host default", () => {
    expect(cargoTarget("linux", "x64"), "returning the gnu triple ties the binary to the builder's glibc").toBe("x86_64-unknown-linux-musl");
    expect(cargoTarget("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
    expect(cargoTarget("win32", "x64"), "applying the musl mapping to every platform breaks the Windows build").toBeUndefined();
    expect(cargoTarget("darwin", "arm64")).toBeUndefined();
    expect(cargoTarget("linux", "riscv64"), "an arch with no mapping must not get a made-up triple").toBeUndefined();
  });

  test("the command is the locked release build of the relay binary only", () => {
    expect(cargoArgs(undefined), "dropping --locked lets the build rewrite relay/Cargo.lock; dropping --bin builds the fake-daemon test double too").toEqual([
      "build",
      "--release",
      "--locked",
      "--bin",
      "claude-peers-relay",
    ]);
    expect(cargoArgs("x86_64-unknown-linux-musl").slice(-2)).toEqual(["--target", "x86_64-unknown-linux-musl"]);
  });

  test("cargo's output path gains the target triple only when --target is passed", () => {
    expect(builtBinaryPath("/r", "linux", undefined), "target/release without a triple").toBe("/r/relay/target/release/claude-peers-relay");
    expect(builtBinaryPath("/r", "linux", "x86_64-unknown-linux-musl"), "omitting the triple copies a stale or missing file").toBe("/r/relay/target/x86_64-unknown-linux-musl/release/claude-peers-relay");
    expect(builtBinaryPath("C:\\Users\\me\\kory", "win32", undefined)).toBe("C:/Users/me/kory/relay/target/release/claude-peers-relay.exe");
  });

  test("the installed binary sits under bin/<platform>-<arch>/ at the repository root", () => {
    expect(installedBinaryPath("/r/", "darwin", "arm64"), "a trailing slash or another directory layout breaks the --fallback and command paths").toBe("/r/bin/darwin-arm64/claude-peers-relay");
  });
});

describe("printed commands", () => {
  test("relay form: both families, absolute paths, the right fallback script each", () => {
    expect(mcpAddCommands({ kind: "relay", binary: "/r/bin/linux-x64/claude-peers-relay" }, "/r"), "swapping the two scripts or the two --family values mixes the families up").toEqual([
      "claude mcp add --scope user --transport stdio claude-peers -- /r/bin/linux-x64/claude-peers-relay --family peers --fallback /r/server.ts",
      "claude mcp add --scope user --transport stdio kory-roadmap -- /r/bin/linux-x64/claude-peers-relay --family roadmap --fallback /r/server-roadmap.ts",
    ]);
  });

  test("a Windows root is printed with forward slashes", () => {
    const [peers] = mcpAddCommands({ kind: "relay", binary: "C:\\Users\\me\\kory\\bin\\win32-x64\\claude-peers-relay.exe" }, "C:\\Users\\me\\kory");
    expect(peers, "keeping backslashes makes Git Bash eat them").toBe(
      "claude mcp add --scope user --transport stdio claude-peers -- C:/Users/me/kory/bin/win32-x64/claude-peers-relay.exe --family peers --fallback C:/Users/me/kory/server.ts",
    );
  });

  test("bun form carries no relay word", () => {
    const cmds = mcpAddCommands({ kind: "bun" }, "/r");
    expect(cmds, "the bun form must start the clone's own servers").toEqual([
      "claude mcp add --scope user --transport stdio claude-peers -- bun /r/server.ts",
      "claude mcp add --scope user --transport stdio kory-roadmap -- bun /r/server-roadmap.ts",
    ]);
    expect(cmds.join("\n"), "relay flags leaking into the bun form").not.toMatch(/--family|--fallback|claude-peers-relay/);
  });

  test("a path with a space or a quote is single-quoted and still one word", () => {
    expect(shellQuote("/home/op/my repo/server.ts"), "no quoting splits the path in two arguments").toBe("'/home/op/my repo/server.ts'");
    expect(shellQuote("/home/o'p/server.ts"), "an unescaped quote ends the quoting early").toBe(`'/home/o'\\''p/server.ts'`);
    expect(shellQuote("/home/op/server.ts"), "plain paths stay unquoted").toBe("/home/op/server.ts");
  });

  test("the form follows the binary: present gives relay, absent gives bun", () => {
    expect(chooseForm("/r/b", true), "inverting the test prints a relay command for a missing binary").toEqual({ kind: "relay", binary: "/r/b" });
    expect(chooseForm("/r/b", false)).toEqual({ kind: "bun" });
  });

  test("the output says the commands are pasted into bash, Git Bash on Windows", () => {
    const { deps, out } = fakeDeps();
    main(["--print-only"], deps);
    expect(out.join("\n"), "the single-quote escaping is POSIX only, the operator must be told which shell").toContain("Paste them into bash (Git Bash on Windows).");
  });
});

describe("installBinary", () => {
  const NEW = `${INSTALLED}.new`;
  const OLD = `${INSTALLED}.old`;

  test("a first install copies beside the destination and renames into place", () => {
    const { fs, files, log } = memFs({ [BUILT]: 11 });
    const r = installBinary(BUILT, INSTALLED, fs);
    expect(r, "copying straight onto the destination skips the .new step").toEqual({ ok: true, binary: INSTALLED, bytes: 11, notes: [] });
    expect(log).toEqual([`mkdir ${ROOT}/bin/linux-x64`, `copy ${BUILT} -> ${NEW}`, `rename ${NEW} -> ${INSTALLED}`]);
    expect([...files.keys()].sort()).toEqual([BUILT, INSTALLED].sort());
  });

  test("a running binary is replaced: the new file is written beside it and the running one is parked", () => {
    const lockedImage: Failure = (op, from, to) => op === "copy" && to === INSTALLED;
    const { fs, files, log } = memFs({ [BUILT]: 22, [INSTALLED]: 11 }, lockedImage);
    const r = installBinary(BUILT, INSTALLED, fs);
    expect(r.ok, "writing onto the destination (the locked image) fails here and stays on the bun form").toBe(true);
    expect(files.get(INSTALLED), "the destination holds the new binary").toBe(22);
    expect(files.get(OLD), "the running binary is parked, untouched").toBe(11);
    expect(log.indexOf(`rename ${INSTALLED} -> ${OLD}`), "the current binary is parked after the copy and before the new one takes its path").toBeGreaterThan(log.indexOf(`copy ${BUILT} -> ${NEW}`));
    expect(log.at(-1)).toBe(`rename ${NEW} -> ${INSTALLED}`);
  });

  test("an unlocked previous .old is deleted first, so copies do not pile up", () => {
    const { fs, files, log } = memFs({ [BUILT]: 22, [INSTALLED]: 11, [OLD]: 5 });
    expect(installBinary(BUILT, INSTALLED, fs).ok).toBe(true);
    expect(log, "skipping the cleanup keeps every old version on disk").toContain(`remove ${OLD}`);
    expect(files.get(OLD)).toBe(11);
  });

  test("a .old still running is left in place, reported, and the next free name is used", () => {
    const locked: Failure = (op, from, to) => (op === "remove" && from === OLD) || (op === "rename" && to === OLD);
    const { fs, files } = memFs({ [BUILT]: 22, [INSTALLED]: 11, [OLD]: 5 }, locked);
    const r = installBinary(BUILT, INSTALLED, fs);
    expect(r.ok, "always parking under .old fails when a session still runs the previous .old").toBe(true);
    expect(r.ok && r.notes.join("\n"), "the operator is told which file stayed").toContain(`${OLD} is still in use by a running session and was left in place`);
    expect(files.get(OLD), "the locked file is untouched").toBe(5);
    expect(files.get(`${INSTALLED}.old1`)).toBe(11);
    expect(files.get(INSTALLED)).toBe(22);
  });

  test("when every parking name is taken by a running copy, the install stops with a reason", () => {
    const names = Array.from({ length: 10 }, (_, i) => (i === 0 ? OLD : `${INSTALLED}.old${i}`));
    const files: Record<string, number> = { [BUILT]: 22, [INSTALLED]: 11 };
    for (const n of names) files[n] = 5;
    const { fs, files: after } = memFs(files, (op, from) => op === "remove" && names.includes(from));
    const r = installBinary(BUILT, INSTALLED, fs);
    expect(r.ok, "an unbounded search never ends").toBe(false);
    expect(r.ok === false && r.reason).toContain("10 previous copies of the relay are still running");
    expect(after.get(INSTALLED), "the current binary stays at its path").toBe(11);
  });

  test("a rename that fails after the current binary was parked puts it back", () => {
    const refuse: Failure = (op, from, to) => op === "rename" && from === NEW && to === INSTALLED;
    const { fs, files } = memFs({ [BUILT]: 22, [INSTALLED]: 11 }, refuse);
    const r = installBinary(BUILT, INSTALLED, fs);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason, "the operator is told how to unlock the install").toContain("close the Claude Code sessions that use the relay, then re-run");
    expect(files.get(INSTALLED), "no rollback leaves the relay path empty and every configured session broken").toBe(11);
    expect(files.has(OLD)).toBe(false);
  });

  test("a copy that fails touches nothing: the current binary is not parked", () => {
    const { fs, files, log } = memFs({ [INSTALLED]: 11 });
    const r = installBinary(BUILT, INSTALLED, fs);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("close the Claude Code sessions that use the relay, then re-run");
    expect(log.filter((l) => l.startsWith("rename")), "parking before the copy leaves no binary when the copy fails").toEqual([]);
    expect(files.get(INSTALLED)).toBe(11);
  });

  test("a .new left by an interrupted run is removed before the copy", () => {
    const { fs, log } = memFs({ [BUILT]: 22, [NEW]: 3 });
    expect(installBinary(BUILT, INSTALLED, fs).ok).toBe(true);
    expect(log.indexOf(`remove ${NEW}`), "copying onto a leftover .new can fail on a locked or half-written file").toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`remove ${NEW}`)).toBeLessThan(log.indexOf(`copy ${BUILT} -> ${NEW}`));
  });
});

describe("buildRelay", () => {
  function tree(name: string, target: string | undefined, platform = "linux") {
    const root = join(work, name);
    const dir = join(root, "relay", "target", ...(target ? [target] : []), "release");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, binaryName(platform)), "relay-bytes");
    return root;
  }

  test("installs the built binary under bin/<platform>-<arch>/ on the real file system", () => {
    const root = tree("ok-musl", "x86_64-unknown-linux-musl");
    const calls: Array<{ cmd: string[]; cwd: string }> = [];
    const r = buildRelay(root, "linux", "x64", (cmd, cwd) => {
      calls.push({ cmd, cwd });
      return { exitCode: 0, stderr: "" };
    });
    expect(r, "not copying, or copying from target/release when --target was used, leaves no installed binary").toEqual({ ok: true, binary: `${root.replace(/\\/g, "/")}/bin/linux-x64/claude-peers-relay`, bytes: 11, notes: [] });
    expect(readFileSync(join(root, "bin", "linux-x64", "claude-peers-relay"), "utf8")).toBe("relay-bytes");
    expect(calls, "cargo runs once, in relay/, with the musl target").toEqual([
      { cmd: ["cargo", "build", "--release", "--locked", "--bin", "claude-peers-relay", "--target", "x86_64-unknown-linux-musl"], cwd: `${root.replace(/\\/g, "/")}/relay` },
    ]);
  });

  test("cargo missing from the PATH is a reported reason, not a throw", () => {
    const r = buildRelay(join(work, "none"), "linux", "x64", () => {
      throw new Error("Executable not found in $PATH");
    });
    expect(r.ok, "letting the spawn error escape crashes the script before it prints the commands").toBe(false);
    expect(r.ok === false && r.reason, "the reason names cargo and where to get it").toMatch(/cargo could not be started.*Executable not found.*rustup\.rs/);
  });

  test("a failed build reports the exit code, the stderr tail and the musl target hint", () => {
    const stderr = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = buildRelay(join(work, "none"), "linux", "x64", () => ({ exitCode: 101, stderr }));
    expect(r.ok, "treating a non-zero exit as success copies a missing file").toBe(false);
    const reason = r.ok === false ? r.reason : "";
    expect(reason).toContain("code 101");
    expect(reason, "the missing-target hint").toContain("rustup target add x86_64-unknown-linux-musl");
    expect(reason, "only the last 8 lines are kept").toContain("line 12");
    expect(reason).not.toContain("line 4\n");
  });

  test("a build that produced no file is a reported install failure", () => {
    const root = join(work, "no-built");
    mkdirSync(join(root, "relay"), { recursive: true });
    const r = buildRelay(root, "win32", "x64", () => ({ exitCode: 0, stderr: "" }));
    expect(r.ok, "a cargo success with no file to copy must not look like an install").toBe(false);
    expect(r.ok === false && r.reason).toMatch(/could not install .*claude-peers-relay\.exe/);
    expect(existsSync(join(root, "bin", "win32-x64", "claude-peers-relay.exe"))).toBe(false);
  });
});

describe("isOlderThanSources", () => {
  test("true only when a source file is strictly newer than the binary", () => {
    expect(isOlderThanSources(100, [50, 200]), "comparing the other way round never reports a stale binary").toBe(true);
    expect(isOlderThanSources(100, [50, 100]), "a source with the binary's own mtime is not newer").toBe(false);
    expect(isOlderThanSources(100, []), "no source file is not stale").toBe(false);
  });
});

describe("main", () => {
  test("--print-only never builds and prints the bun form when no binary exists", () => {
    const { deps, out, ran, mtimeCalls } = fakeDeps();
    const code = main(["--print-only"], deps);
    expect(ran, "calling cargo under --print-only").toEqual([]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Commands for the bun form:");
    expect(out.join("\n")).toContain("No relay binary at /home/op/koryphaios/bin/linux-x64/claude-peers-relay");
    expect(out.join("\n")).toContain("-- bun /home/op/koryphaios/server.ts");
    expect(mtimeCalls, "there is no binary to date").toEqual([]);
  });

  test("--print-only prints the relay form when the binary exists", () => {
    const { deps, out, ran } = fakeDeps({ files: { [INSTALLED]: 11 } });
    expect(main(["--print-only"], deps)).toBe(0);
    expect(ran).toEqual([]);
    expect(out.join("\n"), "checking another path than the installed one prints the wrong form").toContain(
      "-- /home/op/koryphaios/bin/linux-x64/claude-peers-relay --family peers --fallback /home/op/koryphaios/server.ts",
    );
  });

  test("--print-only warns when a relay source is newer than the binary, and stays quiet otherwise", () => {
    const src = [`${ROOT}/relay/src/lib.rs`, `${ROOT}/relay/Cargo.toml`];
    const stale = fakeDeps({ files: { [INSTALLED]: 11 }, sources: src, mtimes: { [INSTALLED]: 100, [src[0]!]: 50, [src[1]!]: 200 } });
    main(["--print-only"], stale.deps);
    expect(stale.out.join("\n"), "dropping the staleness check hides an outdated relay").toContain("The binary is older than relay/: re-run without --print-only.");
    const fresh = fakeDeps({ files: { [INSTALLED]: 11 }, sources: src, mtimes: { [INSTALLED]: 300, [src[0]!]: 50, [src[1]!]: 200 } });
    main(["--print-only"], fresh.deps);
    expect(fresh.out.join("\n"), "warning on a fresh binary trains the operator to ignore the note").not.toContain("older than relay/");
  });

  test("a failed build with no installed binary prints the bun form with the reason and exits 1", () => {
    const { deps, out } = fakeDeps({ run: () => ({ exitCode: 101, stderr: "error: boom" }) });
    const code = main([], deps);
    expect(code, "swallowing the failure exits 0 and hides it from a calling script").toBe(1);
    const text = out.join("\n");
    expect(text).toContain("Relay build failed: cargo exited with code 101");
    expect(text).toContain("error: boom");
    expect(text, "the relay form must not be printed when no binary was installed").not.toContain("--family");
    expect(text).toContain("-- bun /home/op/koryphaios/server-roadmap.ts");
  });

  test("a failed build with a binary already installed keeps the relay form with that binary", () => {
    const { deps, out } = fakeDeps({ files: { [INSTALLED]: 11 }, run: () => ({ exitCode: 101, stderr: "error: boom" }) });
    expect(main([], deps)).toBe(1);
    const text = out.join("\n");
    expect(text, "falling back to bun for a working install hides the real error and degrades the sessions").toContain(`-- ${INSTALLED} --family peers`);
    expect(text).toContain(`The binary already installed at ${INSTALLED} is kept and used below.`);
    expect(text).not.toContain("-- bun ");
  });

  test("an install that fails over a running binary says to close the sessions and keeps the relay form", () => {
    const refuse: Failure = (op, from, to) => op === "rename" && from === `${INSTALLED}.new` && to === INSTALLED;
    const { deps, out, mem } = fakeDeps({ files: { [INSTALLED]: 11 }, refuse });
    expect(main([], deps)).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("close the Claude Code sessions that use the relay, then re-run");
    expect(text, "proposing the bun form here gives no reason for the failure and no way forward").toContain(`-- ${INSTALLED} --family roadmap`);
    expect(mem.files.get(INSTALLED), "the previous binary is back in place").toBe(11);
  });

  test("a successful build over a running relay prints the parking notes", () => {
    const locked: Failure = (op, from, to) => (op === "remove" && from === `${INSTALLED}.old`) || (op === "rename" && to === `${INSTALLED}.old`);
    const { deps, out } = fakeDeps({ files: { [INSTALLED]: 11, [`${INSTALLED}.old`]: 5 }, refuse: locked });
    expect(main([], deps)).toBe(0);
    expect(out.join("\n"), "notes dropped by main hide a leftover locked file").toContain("is still in use by a running session and was left in place");
  });

  test("an unknown argument is a usage error and runs nothing", () => {
    const { deps, out, err, ran } = fakeDeps();
    expect(main(["--write-config"], deps), "accepting unknown flags would hide a typo of --print-only and start a build").toBe(2);
    expect(ran).toEqual([]);
    expect(out).toEqual([]);
    expect(err[0]).toContain("usage:");
  });

  test("the plan states that the script does not write the Claude Code configuration", () => {
    const { deps, out } = fakeDeps();
    main(["--print-only"], deps);
    expect(out.join("\n"), "the closing line is the only place the operator learns the commands are theirs to run").toContain("does not write the Claude Code configuration");
  });
});
