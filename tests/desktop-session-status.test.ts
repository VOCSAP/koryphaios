import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  STATUS_FILE_MAX_BYTES,
  decodeStatusFile,
  encodeStatusFromPayload,
  sameLiveStatus,
  sanitizeStatusToken,
  statusFileName,
} from "../desktop/src/shared/session-status.ts";
import {
  STATUS_SILENCE_MS,
  clearStatusFile,
  pollStatusFile,
  statusSilenceOverdue,
  readStatusFile,
  type StatusFileRead,
} from "../desktop/src/main/session-status-file.ts";
import {
  STATUSLINE_REFRESH_S,
  buildStatusLineSettings,
  statusLineSettingsFileName,
  writeStatusLineSettings,
} from "../desktop/src/main/statusline-settings.ts";
import { sanitizeSessionId } from "../shared/peer-cache.ts";
import { sanitizeToken } from "../desktop/src/main/desk-session.ts";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kory-status-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Payload shape from the statusLine doc (code.claude.com/docs/en/statusline). */
const DOC_PAYLOAD = {
  hook_event_name: "Status",
  session_id: "abc123",
  transcript_path: "/path/to/transcript.jsonl",
  cwd: "/current/working/directory",
  model: { id: "claude-opus-4-1", display_name: "Opus" },
  workspace: { current_dir: "/current/working/directory", project_dir: "/original/project/directory" },
  version: "1.0.80",
  output_style: { name: "default" },
  cost: { total_cost_usd: 0.01234, total_duration_ms: 45000 },
  context_window: {
    total_input_tokens: 15234,
    total_output_tokens: 4521,
    context_window_size: 200000,
    used_percentage: 8,
    remaining_percentage: 92,
  },
};

function file(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, model_id: "claude-opus-4-1", model: "Opus", pct: 42, size: 200000, at: 1000, ...fields });
}

/** JSON.stringify writes Infinity as null, so an overflowing literal is spliced into the raw text. */
function fileWithRaw(field: string, literal: string): string {
  return file({ [field]: "__RAW__" }).replace('"__RAW__"', literal);
}

// ----- token sanitization parity -----

test("statusFileName token sanitization matches the core and desk-session sanitizers", () => {
  for (const token of ["tile-A", "a/../b", "x".repeat(200), "é$`;", "0f9c-uuid"]) {
    expect(sanitizeStatusToken(token), `parity with shared/peer-cache.ts sanitizeSessionId for ${token}`).toBe(
      sanitizeSessionId(token),
    );
    expect(sanitizeStatusToken(token), `parity with desk-session.ts sanitizeToken for ${token}`).toBe(sanitizeToken(token));
  }
  expect(statusFileName("a/b"), "path separators never reach the file name").toBe("desk-status-a_b.json");
  expect(statusFileName(""), "empty token yields no file name").toBe("");
  expect(statusFileName(undefined), "missing token yields no file name").toBe("");
});

// ----- codec -----

test("encode then decode round-trips a realistic doc payload", () => {
  const raw = encodeStatusFromPayload(DOC_PAYLOAD, 1234);
  expect(raw, "encoder accepts the documented payload").not.toBeNull();
  expect(decodeStatusFile(raw!), "decoder returns the encoded report").toEqual({
    model: "Opus",
    modelId: "claude-opus-4-1",
    contextPct: 8,
    contextWindow: 200000,
    at: 1234,
  });
});

test("encoder: null used_percentage (early session, after /compact) stays null", () => {
  const raw = encodeStatusFromPayload({ ...DOC_PAYLOAD, context_window: { ...DOC_PAYLOAD.context_window, used_percentage: null } }, 5);
  expect(decodeStatusFile(raw!)?.contextPct, "null pct preserved").toBeNull();
});

test("encoder: no model means nothing to write", () => {
  expect(encodeStatusFromPayload({}, 5), "payload without model").toBeNull();
  expect(encodeStatusFromPayload(null, 5), "null payload").toBeNull();
  expect(encodeStatusFromPayload({ model: { id: "a;rm -rf", display_name: "x" } }, 5), "hostile model id").toBeNull();
  expect(encodeStatusFromPayload(DOC_PAYLOAD, Number.NaN), "NaN clock").toBeNull();
});

test("encoder: display_name falls back to the id when unusable", () => {
  const raw = encodeStatusFromPayload({ model: { id: "claude-sonnet-4-5", display_name: "$(x)" } }, 5);
  expect(decodeStatusFile(raw!)?.model, "display name replaced by id, never sanitized").toBe("claude-sonnet-4-5");
});

test("decoder: happy path, including [1m] suffix and null pct", () => {
  expect(decodeStatusFile(file({ model_id: "claude-opus-4-6[1m]", model: "Opus 4.6 (1M context)" }))?.modelId,
    "bracketed 1M suffix accepted").toBe("claude-opus-4-6[1m]");
  expect(decodeStatusFile(file({ pct: null }))?.contextPct, "null pct accepted").toBeNull();
});

test("decoder: invalid pct degrades to null, out-of-range pct is clamped", () => {
  // NaN cannot be written as JSON; it arrives as a string or via a non-number.
  expect(decodeStatusFile(file({ pct: "NaN" }))?.contextPct, "string NaN pct -> null").toBeNull();
  expect(decodeStatusFile(file({ pct: "50" }))?.contextPct, "numeric string pct -> null").toBeNull();
  expect(decodeStatusFile(fileWithRaw("pct", "1e400"))?.contextPct, "Infinity pct (1e400) -> null").toBeNull();
  expect(decodeStatusFile(file({ pct: -3 }))?.contextPct, "negative pct clamped to 0").toBe(0);
  expect(decodeStatusFile(file({ pct: 250 }))?.contextPct, "pct over 100 clamped to 100").toBe(100);
  expect(decodeStatusFile(file({ pct: 33.5 }))?.contextPct, "fractional pct kept").toBe(33.5);
});

test("decoder: invalid size degrades to null", () => {
  for (const size of [0, -1, 1.5, "200000", 10_000_001, null]) {
    expect(decodeStatusFile(file({ size }))?.contextWindow, `size ${String(size)} -> null`).toBeNull();
  }
  expect(decodeStatusFile(fileWithRaw("size", "1e400"))?.contextWindow, "infinite size -> null").toBeNull();
  expect(decodeStatusFile(file({ size: 10_000_000 }))?.contextWindow, "size at the cap accepted").toBe(10_000_000);
});

test("decoder: model / model_id outside the charset are rejected, never sanitized", () => {
  for (const bad of ["Opus;rm -rf ~", "$(id)", "`x`", "a\"b", "<img>", "x".repeat(65), "", "Opus\n"]) {
    expect(decodeStatusFile(file({ model: bad })), `model ${JSON.stringify(bad)} rejects the whole report`).toBeNull();
    expect(decodeStatusFile(file({ model_id: bad })), `model_id ${JSON.stringify(bad)} rejects the whole report`).toBeNull();
  }
  expect(decodeStatusFile(file({ model: 42 })), "non-string model rejected").toBeNull();
  expect(decodeStatusFile(file({ model: "x".repeat(64) }))?.model, "64-char model accepted").toBe("x".repeat(64));
});

test("model charset: Unicode letters/numbers and the middle dot pass; hostile classes are refused", () => {
  const accepted = ["Opus 4.6 \u00B7 1M", "Sonnet 4.5 [1m]", "claude-opus-4-1+beta", "Modèle 3 (préversion)", "模型 2"];
  for (const ok of accepted) {
    expect(decodeStatusFile(file({ model: ok }))?.model, `${JSON.stringify(ok)} accepted`).toBe(ok);
  }
  expect(
    decodeStatusFile(encodeStatusFromPayload({ model: { id: "claude-opus-4-6", display_name: "Opus 4.6 \u00B7 1M" } }, 1000)!)?.model,
    "a non-ASCII display_name is kept by the writer, not replaced by the id",
  ).toBe("Opus 4.6 \u00B7 1M");
  const rejected: Record<string, string[]> = {
    "control char": ["Opus\u0000", "Opus\u0007", "Opus\t4", "Opus\u001b[31m", "Opus\u007f", "Opus\u0085"],
    "bidi override/isolate": ["Opus\u202A", "Opus\u202B", "Opus\u202C", "Opus\u202D", "Opus\u202E4", "Opus\u2066", "Opus\u2067", "Opus\u2068", "Opus\u2069"],
    "zero-width": ["Op\u200Bus", "Op\u200Cus", "Op\u200Dus", "Op\u2060us", "\uFEFFOpus"],
    quote: ["O'pus", 'O"pus', "O\u2019pus", "O\u201Cpus"],
    backslash: ["Opus\\4"],
    "angle bracket": ["<Opus", "Opus>"],
    dollar: ["$Opus"],
    backtick: ["Opus`"],
    "length cap": ["\u00E9".repeat(65)],
  };
  for (const [cls, values] of Object.entries(rejected)) {
    for (const bad of values) {
      expect(decodeStatusFile(file({ model: bad })), `${cls}: ${JSON.stringify(bad)} rejected`).toBeNull();
    }
  }
});

test("decoder: wrong version, bad at, garbage and oversized input are rejected", () => {
  expect(decodeStatusFile(file({ v: 2 })), "future version rejected").toBeNull();
  expect(decodeStatusFile(file({ v: "1" })), "string version rejected").toBeNull();
  expect(decodeStatusFile(file({ at: 0 })), "zero timestamp rejected").toBeNull();
  expect(decodeStatusFile(file({ at: "1000" })), "string timestamp rejected").toBeNull();
  expect(decodeStatusFile(fileWithRaw("at", "1e400")), "infinite timestamp rejected").toBeNull();
  expect(decodeStatusFile(fileWithRaw("at", "-5")), "negative timestamp rejected").toBeNull();
  expect(decodeStatusFile("{not json"), "garbage JSON rejected").toBeNull();
  expect(decodeStatusFile("[1,2]"), "array rejected").toBeNull();
  expect(decodeStatusFile("null"), "null rejected").toBeNull();
  expect(decodeStatusFile(""), "empty input rejected").toBeNull();
  const padded = file({ pad: "x".repeat(STATUS_FILE_MAX_BYTES) });
  expect(decodeStatusFile(padded), "input over the size cap rejected before parsing").toBeNull();
});

test("sameLiveStatus compares displayed fields, not the refresh timestamp", () => {
  const a = decodeStatusFile(file({}))!;
  const b = decodeStatusFile(file({ at: 9999 }))!;
  expect(sameLiveStatus(a, b), "a refresh with identical values is not a change").toBe(true);
  expect(sameLiveStatus(a, decodeStatusFile(file({ pct: 43 }))), "pct change detected").toBe(false);
  expect(sameLiveStatus(a, decodeStatusFile(file({ model: "Sonnet" }))), "model change detected").toBe(false);
  expect(sameLiveStatus(a, null), "report -> none detected").toBe(false);
  expect(sameLiveStatus(null, null), "none -> none is not a change").toBe(true);
});

// ----- file reader (main side) -----

test("readStatusFile: absent file, valid file, tampered file", () => {
  const dir = tmpDir();
  expect(readStatusFile("tile-1", dir), "ENOENT reads as absent").toEqual({ kind: "absent" });
  expect(readStatusFile("", dir), "empty token reads as absent").toEqual({ kind: "absent" });
  expect(readStatusFile("tile-1", join(dir, "missing-dir")), "missing peers dir reads as absent").toEqual({ kind: "absent" });

  writeFileSync(join(dir, "desk-status-tile-1.json"), file({}));
  const ok = readStatusFile("tile-1", dir);
  expect(ok.kind, "valid file decodes").toBe("ok");
  expect(ok.kind === "ok" && ok.status.model, "decoded model").toBe("Opus");

  writeFileSync(join(dir, "desk-status-tile-1.json"), file({ model: "$(curl evil)" }));
  expect(readStatusFile("tile-1", dir), "tampered model reads as invalid").toEqual({ kind: "invalid", reason: "rejected" });

  writeFileSync(join(dir, "desk-status-tile-1.json"), "x".repeat(STATUS_FILE_MAX_BYTES + 1));
  expect(readStatusFile("tile-1", dir), "oversized file reads as invalid").toEqual({ kind: "invalid", reason: "oversized" });

  // Valid JSON padded past the cap: only the fstat size check refuses it (a
  // bounded read of the first bytes would still parse as a genuine report).
  writeFileSync(join(dir, "desk-status-tile-1.json"), file({}) + " ".repeat(STATUS_FILE_MAX_BYTES));
  expect(readStatusFile("tile-1", dir), "valid-but-oversized file refused by the size check").toEqual({
    kind: "invalid",
    reason: "oversized",
  });

  mkdirSync(join(dir, "desk-status-tile-2.json"));
  expect(readStatusFile("tile-2", dir), "a directory in place of the file is refused as not a regular file").toEqual({
    kind: "invalid",
    reason: "not-file",
  });
});

test.skipIf(process.platform === "win32")("readStatusFile refuses a planted symlink", () => {
  const dir = tmpDir();
  const target = join(dir, "elsewhere.json");
  writeFileSync(target, file({}));
  symlinkSync(target, join(dir, "desk-status-tile-3.json"));
  expect(readStatusFile("tile-3", dir), "symlinked status file is not followed").toEqual({ kind: "invalid", reason: "symlink" });
});

test.skipIf(process.platform === "win32")("readStatusFile refuses a FIFO without blocking", () => {
  const dir = tmpDir();
  const fifo = join(dir, "desk-status-tile-4.json");
  const made = spawnSync("mkfifo", [fifo]);
  expect(made.status, "mkfifo available on this platform").toBe(0);
  expect(readStatusFile("tile-4", dir), "a FIFO is refused as not a regular file, and the read returns").toEqual({
    kind: "invalid",
    reason: "not-file",
  });
});

// ----- poll gate -----

const OK: StatusFileRead = {
  kind: "ok",
  status: { model: "Opus", modelId: "claude-opus-4-1", contextPct: 10, contextWindow: 200000, at: 1000 },
};

test("pollStatusFile never reads for a dead tile or a tile spawned without the statusLine", () => {
  let reads = 0;
  const read = (): StatusFileRead => {
    reads++;
    return OK;
  };
  expect(pollStatusFile({ alive: true, enabled: false, spawnedAt: 0 }, read), "statusLine-less tile (sandboxed, non-claude) shows nothing").toEqual({ kind: "absent" });
  expect(pollStatusFile({ alive: false, enabled: true, spawnedAt: 0 }, read), "dead tile shows nothing").toEqual({ kind: "absent" });
  expect(reads, "the container-writable file is not even read for a gated tile").toBe(0);
  expect(pollStatusFile({ alive: true, enabled: true, spawnedAt: 0 }, read), "enabled live tile reads its report").toEqual(OK);
  expect(reads, "enabled live tile reads once").toBe(1);
});

test("pollStatusFile drops a report written before this spawn", () => {
  expect(pollStatusFile({ alive: true, enabled: true, spawnedAt: 1001 }, () => OK), "late report of the previous process ignored").toEqual({ kind: "absent" });
  expect(pollStatusFile({ alive: true, enabled: true, spawnedAt: 1000 }, () => OK), "report at the spawn instant accepted").toEqual(OK);
  const bad: StatusFileRead = { kind: "invalid", reason: "rejected" };
  expect(pollStatusFile({ alive: true, enabled: true, spawnedAt: 5000 }, () => bad), "refusals pass through for reporting").toEqual(bad);
});

test("statusSilenceOverdue: once, for a live statusLine tile with no report past the grace period", () => {
  const base = { alive: true, enabled: true, spawnedAt: 1_000_000, now: 1_000_000 + STATUS_SILENCE_MS, reported: false, warned: false };
  expect(statusSilenceOverdue(base), "silent past the grace period").toBe(true);
  expect(statusSilenceOverdue({ ...base, now: base.now - 1 }), "still inside the grace period").toBe(false);
  expect(statusSilenceOverdue({ ...base, reported: true }), "a report arrived").toBe(false);
  expect(statusSilenceOverdue({ ...base, warned: true }), "already warned for this spawn").toBe(false);
  expect(statusSilenceOverdue({ ...base, alive: false }), "dead tile").toBe(false);
  expect(statusSilenceOverdue({ ...base, enabled: false }), "spawn without --settings").toBe(false);
  expect(statusSilenceOverdue({ ...base, spawnedAt: 0 }), "never spawned").toBe(false);
  expect(statusSilenceOverdue({ ...base, spawnedAt: Number.NaN }), "NaN spawnedAt").toBe(false);
  expect(statusSilenceOverdue({ ...base, now: Number.NaN }), "NaN now").toBe(false);
});

test("clearStatusFile removes the file and tolerates its absence", () => {
  const dir = tmpDir();
  const p = join(dir, "desk-status-tile-1.json");
  writeFileSync(p, file({}));
  expect(clearStatusFile("tile-1", dir), "clearing an existing file reports no error").toBeNull();
  expect(existsSync(p), "stale status file removed before respawn").toBe(false);
  expect(clearStatusFile("tile-1", dir), "clearing a missing file reports no error").toBeNull();
});

// ----- --settings file -----

test("buildStatusLineSettings: command, refresh interval, win32 forward slashes", () => {
  const posix = JSON.parse(buildStatusLineSettings("/opt/kory/deck-plugin/hooks/desk-statusline.mjs", "linux")!);
  expect(posix, "statusLine settings shape").toEqual({
    statusLine: {
      type: "command",
      command: 'bun "/opt/kory/deck-plugin/hooks/desk-statusline.mjs"',
      refreshInterval: STATUSLINE_REFRESH_S,
    },
  });
  const win = JSON.parse(buildStatusLineSettings("C:\\Program Files\\Kory\\deck-plugin\\hooks\\desk-statusline.mjs", "win32")!);
  expect(win.statusLine.command, "win32 path uses forward slashes only").toBe(
    'bun "C:/Program Files/Kory/deck-plugin/hooks/desk-statusline.mjs"',
  );
});

test("buildStatusLineSettings refuses a path that would break the quoted command", () => {
  for (const bad of ['/a"b/x.mjs', "/a$(id)/x.mjs", "/a`id`/x.mjs", "/a%PATH%/x.mjs", "/a\nb/x.mjs", ""]) {
    expect(buildStatusLineSettings(bad, "linux"), `unsafe hook path ${JSON.stringify(bad)} refused`).toBeNull();
  }
});

test("writeStatusLineSettings writes a content-keyed file", () => {
  const dir = join(tmpDir(), "state");
  const a = writeStatusLineSettings(dir, "/one/desk-statusline.mjs", "linux")!;
  const b = writeStatusLineSettings(dir, "/two/desk-statusline.mjs", "linux")!;
  expect(a === b, "two hook paths never share one settings file").toBe(false);
  expect(writeStatusLineSettings(dir, "/one/desk-statusline.mjs", "linux"), "same content, same file").toBe(a);
  const content = readFileSync(a, "utf-8");
  expect(a.endsWith(statusLineSettingsFileName(content)), "file name derives from its content").toBe(true);
  expect(JSON.parse(content).statusLine.command, "written content").toBe('bun "/one/desk-statusline.mjs"');
  expect(writeStatusLineSettings(dir, '/bad"/x.mjs', "linux"), "unsafe hook path writes nothing").toBeNull();
  const badDir = join(tmpDir(), "a$HOME");
  expect(writeStatusLineSettings(badDir, "/one/desk-statusline.mjs", "linux"), "unsafe --settings path refused").toBeNull();
  expect(existsSync(badDir), "nothing created for a refused settings path").toBe(false);
});
