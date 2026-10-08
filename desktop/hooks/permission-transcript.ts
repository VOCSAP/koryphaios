import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_LINES = 10_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

type TranscriptEntry = {
  value: JsonRecord;
  uuid: string | null;
  parentUuid: string | null;
  promptId: string | null;
};

export interface PermissionTranscriptContext {
  transcriptPath: string;
  promptId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  agentId?: string;
}

export type PermissionTranscriptInspection =
  | { kind: "none" }
  | { kind: "fragment" }
  | { kind: "invalid" }
  | { kind: "limit" }
  | { kind: "ambiguous" }
  | { kind: "candidate"; toolUseId: string; hasResult: boolean };

export type PermissionTranscriptOutcome =
  | "result"
  | "ambiguous"
  | "completed"
  | "changed"
  | "invalid"
  | "limit"
  | "disposed";

export interface PermissionTranscriptObserver {
  readonly acquired: Promise<void>;
  readonly finished: Promise<PermissionTranscriptOutcome>;
  readonly resultSignal: AbortSignal;
  readonly toolUseId: string | null;
  dispose(): void;
}

export interface PermissionTranscriptFileState {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface PermissionTranscriptIo {
  open(path: string): number;
  close(descriptor: number): void;
  stat(descriptor: number): PermissionTranscriptFileState;
  read(descriptor: number, buffer: Buffer, offset: number, length: number, position: number): number;
}

export interface PermissionTranscriptTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface PermissionTranscriptObserverOptions {
  intervalMs?: number;
  maxBytes?: number;
  maxLines?: number;
  io?: PermissionTranscriptIo;
  timers?: PermissionTranscriptTimers;
}

function isRecord(value: JsonValue | unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value === "boolean" || typeof current.value === "string") continue;
    if (typeof current.value === "number") {
      if (Number.isFinite(current.value)) continue;
      return false;
    }
    if ((!Array.isArray(current.value) && !isRecord(current.value)) || current.depth >= 256 || seen.has(current.value)) return false;
    seen.add(current.value);
    for (const nested of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
      stack.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return true;
}

function stringField(value: JsonRecord, name: string): string | null {
  const field = value[name];
  return typeof field === "string" ? field : null;
}

function contents(entry: TranscriptEntry): JsonRecord[] {
  const message = entry.value.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
  const stack: Array<{ left: JsonValue; right: JsonValue; depth: number }> = [{ left, right, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.left === current.right) continue;
    if (typeof current.left !== typeof current.right || current.left === null || current.right === null) return false;
    if (Array.isArray(current.left) || Array.isArray(current.right)) {
      if (!Array.isArray(current.left) || !Array.isArray(current.right) || current.left.length !== current.right.length) return false;
      if (current.depth >= 256) return false;
      for (let index = 0; index < current.left.length; index++) {
        stack.push({ left: current.left[index]!, right: current.right[index]!, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.left) || !isRecord(current.right) || current.depth >= 256) return false;
    const leftKeys = Object.keys(current.left);
    const rightKeys = Object.keys(current.right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(current.right, key)) return false;
      stack.push({ left: current.left[key]!, right: current.right[key]!, depth: current.depth + 1 });
    }
  }
  return true;
}

function canonicalToolInput(input: JsonValue, platform: NodeJS.Platform): JsonValue {
  if (platform !== "win32" || !isRecord(input)) return input;
  let canonical: JsonRecord | null = null;
  for (const key of ["file_path", "notebook_path", "path"] as const) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const normalized = value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
    if (normalized !== value) (canonical ??= { ...input })[key] = normalized;
  }
  return canonical ?? input;
}

function parseEntries(
  raw: string,
  maxLines: number
): { kind: "entries"; entries: TranscriptEntry[] } | { kind: "fragment" | "invalid" | "limit" } {
  if (raw !== "" && !raw.endsWith("\n")) return { kind: "fragment" };
  const lines = raw === "" ? [] : raw.slice(0, -1).split("\n");
  if (lines.length > maxLines) return { kind: "limit" };
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (line === "") return { kind: "invalid" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { kind: "invalid" };
    }
    if (!isRecord(parsed)) return { kind: "invalid" };
    entries.push({
      value: parsed,
      uuid: stringField(parsed, "uuid"),
      parentUuid: stringField(parsed, "parentUuid"),
      promptId: stringField(parsed, "promptId"),
    });
  }
  return { kind: "entries", entries };
}

function hasPromptAncestor(entry: TranscriptEntry, entriesByUuid: ReadonlyMap<string, TranscriptEntry>, promptId: string): boolean {
  const visited = new Set<string>();
  let parentUuid = entry.parentUuid;
  while (parentUuid !== null) {
    if (visited.has(parentUuid)) return false;
    visited.add(parentUuid);
    const parent = entriesByUuid.get(parentUuid);
    if (parent === undefined) return false;
    if (parent.promptId === promptId) return true;
    parentUuid = parent.parentUuid;
  }
  return false;
}

export function inspectPermissionTranscript(
  context: Pick<PermissionTranscriptContext, "promptId" | "toolName" | "toolInput">,
  raw: string,
  maxLines = DEFAULT_MAX_LINES,
  platform: NodeJS.Platform = process.platform
): PermissionTranscriptInspection {
  const contextInput = context.toolInput;
  if (!isJsonValue(contextInput)) return { kind: "invalid" };
  const canonicalContextInput = canonicalToolInput(contextInput as JsonRecord, platform);
  const parsed = parseEntries(raw, maxLines);
  if (parsed.kind !== "entries") return parsed;

  const entriesByUuid = new Map<string, TranscriptEntry>();
  for (const entry of parsed.entries) {
    if (entry.uuid === null) continue;
    if (entriesByUuid.has(entry.uuid)) return { kind: "invalid" };
    entriesByUuid.set(entry.uuid, entry);
  }

  const candidates = new Map<string, TranscriptEntry>();
  const resultIds = new Set<string>();
  for (const entry of parsed.entries) {
    for (const content of contents(entry)) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        resultIds.add(content.tool_use_id);
      }
      if (
        content.type === "tool_use"
        && typeof content.id === "string"
        && content.name === context.toolName
        && isJsonValue(content.input)
        && deepEqual(canonicalToolInput(content.input, platform), canonicalContextInput)
        && hasPromptAncestor(entry, entriesByUuid, context.promptId)
      ) {
        candidates.set(content.id, entry);
      }
    }
  }

  if (candidates.size > 1) return { kind: "ambiguous" };
  const candidateId = candidates.keys().next().value;
  if (candidateId === undefined) return { kind: "none" };
  return { kind: "candidate", toolUseId: candidateId, hasResult: resultIds.has(candidateId) };
}

export function resolvePermissionTranscriptPath(transcriptPath: string, agentId?: string): string | null {
  if (!transcriptPath.endsWith(".jsonl")) return null;
  if (agentId === undefined) return transcriptPath;
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return null;
  const separator = transcriptPath.includes("\\") ? "\\" : "/";
  return `${transcriptPath.slice(0, -".jsonl".length)}${separator}subagents${separator}agent-${agentId}.jsonl`;
}

const FILE_IO: PermissionTranscriptIo = {
  open: (path) => openSync(path, "r"),
  close: (descriptor) => closeSync(descriptor),
  stat: (descriptor) => {
    const stats = fstatSync(descriptor);
    return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
  },
  read: (descriptor, buffer, offset, length, position) => readSync(descriptor, buffer, offset, length, position),
};

const TIMERS: PermissionTranscriptTimers = {
  setTimeout,
  clearTimeout,
};

function readBounded(descriptor: number, maxBytes: number, io: PermissionTranscriptIo): Buffer | null {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const read = io.read(descriptor, buffer, length, buffer.length - length, length);
    if (read === 0) break;
    length += read;
  }
  return length > maxBytes ? null : buffer.subarray(0, length);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sameState(left: PermissionTranscriptFileState, right: PermissionTranscriptFileState): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export function observePermissionTranscript(
  context: PermissionTranscriptContext,
  options: PermissionTranscriptObserverOptions = {}
): PermissionTranscriptObserver {
  const transcriptPath = resolvePermissionTranscriptPath(context.transcriptPath, context.agentId);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const io = options.io ?? FILE_IO;
  const timers = options.timers ?? TIMERS;
  const resultController = new AbortController();
  let resolveAcquired: () => void = () => {};
  let resolveFinished: (outcome: PermissionTranscriptOutcome) => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    resolveAcquired = resolve;
  });
  const finished = new Promise<PermissionTranscriptOutcome>((resolve) => {
    resolveFinished = resolve;
  });
  let outcome: PermissionTranscriptOutcome | null = null;
  let timer: unknown = null;
  let seenFile = false;
  let lastState: PermissionTranscriptFileState | null = null;
  let toolUseId: string | null = null;

  const finish = (next: PermissionTranscriptOutcome): void => {
    if (outcome !== null) return;
    outcome = next;
    if (timer !== null) timers.clearTimeout(timer);
    if (next === "result") resultController.abort();
    resolveFinished(next);
  };

  const schedule = (): void => {
    if (outcome === null) timer = timers.setTimeout(poll, intervalMs);
  };

  const poll = (): void => {
    if (outcome !== null) return;
    if (transcriptPath === null) {
      finish("invalid");
      return;
    }
    let descriptor: number | null = null;
    try {
      descriptor = io.open(transcriptPath);
      const state = io.stat(descriptor);
      if (lastState !== null) {
        if (state.dev !== lastState.dev || state.ino !== lastState.ino || state.size < lastState.size) {
          finish("invalid");
          return;
        }
        if (sameState(state, lastState)) {
          schedule();
          return;
        }
      }
      const raw = readBounded(descriptor, maxBytes, io);
      seenFile = true;
      if (raw === null) {
        finish("limit");
        return;
      }
      lastState = state;
      const inspected = inspectPermissionTranscript(context, raw.toString("utf8"), maxLines);
      if (inspected.kind === "invalid") {
        finish("invalid");
        return;
      }
      if (inspected.kind === "limit") {
        finish("limit");
        return;
      }
      if (inspected.kind === "ambiguous") {
        finish("ambiguous");
        return;
      }
      if (inspected.kind === "fragment") {
        schedule();
        return;
      }
      if (inspected.kind === "none") {
        if (toolUseId !== null) finish("invalid");
        else schedule();
        return;
      }
      if (toolUseId === null) {
        if (inspected.hasResult) finish("completed");
        else {
          toolUseId = inspected.toolUseId;
          resolveAcquired();
          schedule();
        }
        return;
      }
      if (inspected.toolUseId !== toolUseId) {
        finish("invalid");
        return;
      }
      if (inspected.hasResult) finish("result");
      else schedule();
    } catch (error) {
      if (isMissingFile(error) && !seenFile) schedule();
      else finish("invalid");
    } finally {
      if (descriptor !== null) io.close(descriptor);
    }
  };

  queueMicrotask(() => {
    try {
      if (!isJsonValue(context.toolInput)) finish("invalid");
      else poll();
    } catch {
      finish("invalid");
    }
  });
  return {
    acquired,
    finished,
    resultSignal: resultController.signal,
    get toolUseId() {
      return toolUseId;
    },
    dispose() {
      finish("disposed");
    },
  };
}
