import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectPermissionTranscript,
  observePermissionTranscript,
  resolvePermissionTranscriptPath,
  type PermissionTranscriptContext,
  type PermissionTranscriptOutcome,
} from "../desktop/hooks/permission-transcript.ts";

const dirs: string[] = [];
const context: PermissionTranscriptContext = {
  transcriptPath: "/sessions/main.jsonl",
  promptId: "prompt-main",
  toolName: "Write",
  toolInput: { file_path: "/repo/a.ts", content: "const answer = 42" },
};

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function prompt(uuid = "prompt"): Record<string, unknown> {
  return { uuid, promptId: context.promptId };
}

function tool(
  id: string,
  parentUuid = "prompt",
  input: Record<string, unknown> = context.toolInput
): Record<string, unknown> {
  return {
    uuid: `tool-${id}`,
    parentUuid,
    message: { content: [{ type: "tool_use", id, name: context.toolName, input }] },
  };
}

function result(id: string, parentUuid = `tool-${id}`): Record<string, unknown> {
  return {
    uuid: `result-${id}`,
    parentUuid,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
  };
}

function transcript(...entries: Record<string, unknown>[]): string {
  return entries.map(line).join("");
}

const NOT_SETTLED = "not settled" as const;

function settledNow<T>(promise: Promise<T>): Promise<Awaited<T> | typeof NOT_SETTLED> {
  return Promise.race([promise, Promise.resolve<typeof NOT_SETTLED>(NOT_SETTLED)]);
}

function transcriptIo(initial: string, shortReadBytes = Number.POSITIVE_INFINITY): {
  io: {
    open(path: string): number;
    close(descriptor: number): void;
    stat(descriptor: number): { dev: number; ino: number; size: number; mtimeMs: number };
    read(descriptor: number, buffer: Buffer, offset: number, length: number, position: number): number;
  };
  setRaw(raw: string): void;
  replace(raw: string): void;
  readonly bytesRead: number;
  readonly reads: number;
  readonly readPasses: number;
  readonly operations: number;
} {
  let raw = initial;
  let fileIdentity = 0;
  let mtimeMs = 0;
  let nextDescriptor = 1;
  let bytesRead = 0;
  let reads = 0;
  let readPasses = 0;
  let operations = 0;
  const descriptors = new Map<number, { raw: Buffer; state: { dev: number; ino: number; size: number; mtimeMs: number }; readStarted: boolean }>();
  return {
    io: {
      open: () => {
        operations++;
        const descriptor = nextDescriptor++;
        const snapshot = Buffer.from(raw);
        descriptors.set(descriptor, {
          raw: snapshot,
          state: { dev: 1, ino: fileIdentity, size: snapshot.length, mtimeMs },
          readStarted: false,
        });
        return descriptor;
      },
      close: (descriptor) => {
        operations++;
        descriptors.delete(descriptor);
      },
      stat: (descriptor) => {
        operations++;
        const current = descriptors.get(descriptor);
        if (current === undefined) throw new Error("unknown descriptor");
        return current.state;
      },
      read: (descriptor, buffer, offset, length, position) => {
        operations++;
        reads++;
        const current = descriptors.get(descriptor);
        if (current === undefined) throw new Error("unknown descriptor");
        if (!current.readStarted) {
          current.readStarted = true;
          readPasses++;
        }
        const count = Math.min(length, shortReadBytes, current.raw.length - position);
        if (count <= 0) return 0;
        current.raw.copy(buffer, offset, position, position + count);
        bytesRead += count;
        return count;
      },
    },
    setRaw(next: string) {
      raw = next;
      mtimeMs++;
    },
    replace(next: string) {
      raw = next;
      fileIdentity++;
      mtimeMs++;
    },
    get bytesRead() {
      return bytesRead;
    },
    get reads() {
      return reads;
    },
    get readPasses() {
      return readPasses;
    },
    get operations() {
      return operations;
    },
  };
}

function manualTimers(): {
  timers: {
    setTimeout(callback: () => void, delay: number): number;
    clearTimeout(id: number): void;
  };
  runNext(): void;
  readonly pending: number;
} {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    timers: {
      setTimeout(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      clearTimeout(id) {
        callbacks.delete(id);
      },
    },
    runNext() {
      const next = callbacks.entries().next().value;
      if (next === undefined) throw new Error("no scheduled callback");
      callbacks.delete(next[0]);
      next[1]();
    },
    get pending() {
      return callbacks.size;
    },
  };
}

function deeplyNestedValue(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("permission transcript identity", () => {
  test("accepts one still-open exact call through a multi-hop prompt ancestry", () => {
    const inspected = inspectPermissionTranscript(
      context,
      transcript(prompt(), { uuid: "middle", parentUuid: "prompt" }, tool("tool-1", "middle"))
    );

    expect(inspected).toEqual({ kind: "candidate", toolUseId: "tool-1", hasResult: false });
  });

  test("matches object keys independent of order but rejects every incomplete equality", () => {
    const equivalent = { content: "const answer = 42", file_path: "/repo/a.ts" };
    expect(inspectPermissionTranscript(context, transcript(prompt(), tool("same", "prompt", equivalent)))).toMatchObject({
      kind: "candidate",
      toolUseId: "same",
    });

    for (const input of [
      { ...context.toolInput, extra: true },
      { file_path: "/repo/a.ts", content: 42 },
      { file_path: "/repo/a.ts", content: ["const answer = 42"] },
    ]) {
      expect(inspectPermissionTranscript(context, transcript(prompt(), tool("different", "prompt", input)))).toEqual({ kind: "none" });
    }

    const arrayContext = { ...context, toolInput: { values: [1, 2] } };
    expect(inspectPermissionTranscript(arrayContext, transcript(prompt(), tool("ordered", "prompt", { values: [1, 2] })))).toMatchObject({
      kind: "candidate",
      toolUseId: "ordered",
    });
    expect(inspectPermissionTranscript(arrayContext, transcript(prompt(), tool("reversed", "prompt", { values: [2, 1] })))).toEqual({ kind: "none" });

    const longContext = { ...context, toolInput: { content: `${"x".repeat(160)}same` } };
    expect(inspectPermissionTranscript(longContext, transcript(prompt(), tool("long", "prompt", { content: `${"x".repeat(160)}different` })))).toEqual({ kind: "none" });
  });

  test("acquires an Edit whose file path differs only by Windows separators", () => {
    const input = { file_path: "C:\\Users\\agent\\note.txt", old_string: "before", new_string: "after" };
    const editContext = { promptId: "prompt-edit", toolName: "Edit", toolInput: input };
    const raw = transcript(
      { uuid: "edit-prompt", promptId: "prompt-edit" },
      {
        uuid: "edit-tool",
        parentUuid: "edit-prompt",
        message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { ...input, file_path: "C:/Users/agent/note.txt" } }] },
      }
    );

    expect(inspectPermissionTranscript(editContext, raw, undefined, "win32")).toEqual({ kind: "candidate", toolUseId: "edit-1", hasResult: false });
    expect(inspectPermissionTranscript(editContext, raw, undefined, "linux")).toEqual({ kind: "none" });
  });

  test("normalizes every permitted top-level native path field on win32", () => {
    for (const key of ["file_path", "notebook_path", "path"] as const) {
      const input = { [key]: "C:\\Users\\agent\\note.txt" };
      const raw = transcript(
        { uuid: "native-prompt", promptId: "prompt-native" },
        {
          uuid: `native-${key}`,
          parentUuid: "native-prompt",
          message: { content: [{ type: "tool_use", id: key, name: "Read", input: { [key]: "C:/Users/agent/note.txt" } }] },
        }
      );

      expect(inspectPermissionTranscript({ promptId: "prompt-native", toolName: "Read", toolInput: input }, raw, undefined, "win32")).toEqual({ kind: "candidate", toolUseId: key, hasResult: false });
      expect(inspectPermissionTranscript({ promptId: "prompt-native", toolName: "Read", toolInput: input }, raw, undefined, "linux")).toEqual({ kind: "none" });
    }
  });

  test("distinguishes two Edit calls to one canonical file by old_string", () => {
    const first = { file_path: "C:\\Users\\agent\\note.txt", old_string: "one", new_string: "next" };
    const second = { file_path: "C:\\Users\\agent\\note.txt", old_string: "two", new_string: "next" };
    const raw = transcript(
      { uuid: "edit-prompt", promptId: "prompt-edit" },
      {
        uuid: "edit-first",
        parentUuid: "edit-prompt",
        message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { ...first, file_path: "C:/Users/agent/note.txt" } }] },
      },
      {
        uuid: "edit-second",
        parentUuid: "edit-prompt",
        message: { content: [{ type: "tool_use", id: "edit-2", name: "Edit", input: { ...second, file_path: "C:/Users/agent/note.txt" } }] },
      }
    );

    expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: first }, raw, undefined, "win32")).toEqual({ kind: "candidate", toolUseId: "edit-1", hasResult: false });
    expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: second }, raw, undefined, "win32")).toEqual({ kind: "candidate", toolUseId: "edit-2", hasResult: false });
    expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: first }, raw, undefined, "linux")).toEqual({ kind: "none" });
    expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: second }, raw, undefined, "linux")).toEqual({ kind: "none" });
  });

  test("treats duplicate Edit calls with equivalent Windows paths as ambiguous", () => {
    const input = { file_path: "C:\\Users\\agent\\note.txt", old_string: "before", new_string: "after" };
    const raw = transcript(
      { uuid: "edit-prompt", promptId: "prompt-edit" },
      { uuid: "edit-backslash", parentUuid: "edit-prompt", message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input }] } },
      {
        uuid: "edit-slash",
        parentUuid: "edit-prompt",
        message: { content: [{ type: "tool_use", id: "edit-2", name: "Edit", input: { ...input, file_path: "C:/Users/agent/note.txt" } }] },
      }
    );

    expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: input }, raw, undefined, "win32")).toEqual({ kind: "ambiguous" });
    expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: input }, raw, undefined, "linux")).toEqual({ kind: "candidate", toolUseId: "edit-1", hasResult: false });
  });

  test("does not normalize separators in non-path Edit fields", () => {
    for (const field of ["old_string", "new_string"] as const) {
      const input = { file_path: "C:\\Users\\agent\\note.txt", old_string: "before", new_string: "after", [field]: "C:\\before" };
      const raw = transcript(
        { uuid: "edit-prompt", promptId: "prompt-edit" },
        {
          uuid: "edit-tool",
          parentUuid: "edit-prompt",
          message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { ...input, file_path: "C:/Users/agent/note.txt", [field]: "C:/before" } }] },
        }
      );

      expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: input }, raw, undefined, "win32")).toEqual({ kind: "none" });
      expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: input }, raw, undefined, "linux")).toEqual({ kind: "none" });
    }
  });

  test("keeps backslashes significant in path fields outside win32", () => {
    const input = { file_path: "C:\\Users\\agent\\note.txt", old_string: "before", new_string: "after" };
    const raw = transcript(
      { uuid: "edit-prompt", promptId: "prompt-edit" },
      {
        uuid: "edit-tool",
        parentUuid: "edit-prompt",
        message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { ...input, file_path: "C:/Users/agent/note.txt" } }] },
      }
    );

    expect(inspectPermissionTranscript({ promptId: "prompt-edit", toolName: "Edit", toolInput: input }, raw, undefined, "linux")).toEqual({ kind: "none" });
  });

  test("rejects distinct canonical paths on win32", () => {
    const input = { file_path: "C:\\Users\\agent\\first.txt" };
    const raw = transcript(
      { uuid: "path-prompt", promptId: "prompt-path" },
      {
        uuid: "path-tool",
        parentUuid: "path-prompt",
        message: { content: [{ type: "tool_use", id: "path-1", name: "Read", input: { file_path: "c:/Users/agent/second.txt" } }] },
      }
    );

    expect(inspectPermissionTranscript({ promptId: "prompt-path", toolName: "Read", toolInput: input }, raw, undefined, "win32")).toEqual({ kind: "none" });
  });

  test("canonicalizes the drive letter case on win32", () => {
    const input = { file_path: "C:/Users/agent/note.txt" };
    const raw = transcript(
      { uuid: "drive-prompt", promptId: "prompt-drive" },
      {
        uuid: "drive-tool",
        parentUuid: "drive-prompt",
        message: { content: [{ type: "tool_use", id: "drive-1", name: "Read", input: { file_path: "c:\\Users\\agent\\note.txt" } }] },
      }
    );

    expect(inspectPermissionTranscript({ promptId: "prompt-drive", toolName: "Read", toolInput: input }, raw, undefined, "win32")).toEqual({ kind: "candidate", toolUseId: "drive-1", hasResult: false });
    expect(inspectPermissionTranscript({ promptId: "prompt-drive", toolName: "Read", toolInput: input }, raw, undefined, "linux")).toEqual({ kind: "none" });
  });

  test("does not canonicalize nested path fields", () => {
    const input = { file_path: "C:/Users/agent/note.txt", nested: { file_path: "C:\\Users\\agent\\nested.txt" } };
    const raw = transcript(
      { uuid: "nested-prompt", promptId: "prompt-nested" },
      {
        uuid: "nested-tool",
        parentUuid: "nested-prompt",
        message: { content: [{ type: "tool_use", id: "nested-1", name: "Read", input: { file_path: "C:/Users/agent/note.txt", nested: { file_path: "C:/Users/agent/nested.txt" } } }] },
      }
    );

    expect(inspectPermissionTranscript({ promptId: "prompt-nested", toolName: "Read", toolInput: input }, raw, undefined, "win32")).toEqual({ kind: "none" });
    expect(inspectPermissionTranscript({ promptId: "prompt-nested", toolName: "Read", toolInput: input }, raw, undefined, "linux")).toEqual({ kind: "none" });
  });

  test("rejects foreign, missing, cyclic, and contradictory prompt ancestry", () => {
    const foreign = transcript({ uuid: "foreign", promptId: "another" }, tool("foreign-tool", "foreign"));
    const missing = transcript(tool("missing-tool", "unknown"));
    const cyclic = transcript(
      { uuid: "cycle-a", parentUuid: "cycle-b" },
      { uuid: "cycle-b", parentUuid: "cycle-a" },
      tool("cycle-tool", "cycle-a")
    );
    const contradictory = transcript(prompt(), prompt(), tool("duplicate-uuid"));
    const forged = transcript({
      uuid: "forged-tool",
      promptId: context.promptId,
      message: { content: [{ type: "tool_use", id: "forged", name: context.toolName, input: context.toolInput }] },
    });

    for (const raw of [foreign, missing, cyclic, contradictory, forged]) {
      expect(inspectPermissionTranscript(context, raw)).not.toMatchObject({ kind: "candidate" });
    }
  });

  test("uses only the declared subagent transcript and rejects unsafe agent ids", () => {
    expect(resolvePermissionTranscriptPath("/sessions/main.jsonl", "agent-a")).toBe("/sessions/main/subagents/agent-agent-a.jsonl");
    expect(resolvePermissionTranscriptPath("/sessions/main.jsonl", "../parent")).toBeNull();
    expect(resolvePermissionTranscriptPath("/sessions/main.jsonl", "")).toBeNull();
    expect(resolvePermissionTranscriptPath("/sessions/main.txt", "agent-a")).toBeNull();
  });

  test("counts completed homonyms before adopting any open candidate", () => {
    const raw = transcript(prompt(), tool("finished"), result("finished"), tool("open"));
    expect(inspectPermissionTranscript(context, raw)).toEqual({ kind: "ambiguous" });
  });

  test("rejects deeply nested agent input without throwing", () => {
    const input = deeplyNestedValue(20_000);
    const nestedContext = { ...context, toolInput: input };
    expect(() => inspectPermissionTranscript(nestedContext, transcript(prompt(), tool("deep", "prompt", input)))).not.toThrow();
    expect(inspectPermissionTranscript(nestedContext, transcript(prompt(), tool("deep", "prompt", input)))).toEqual({ kind: "invalid" });
  });
});

describe("permission transcript observer", () => {
  test("closes a deeply nested context as invalid before polling", async () => {
    const timers = manualTimers();
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/deep.jsonl", toolInput: deeplyNestedValue(20_000) },
      { io: transcriptIo("").io, timers: timers.timers }
    );

    await Promise.resolve();
    expect(await settledNow(observer.finished)).toBe("invalid");
    expect(timers.pending).toBe(0);
  });

  test("waits for its exact subagent file and never substitutes the parent transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-permission-transcript-"));
    dirs.push(dir);
    const parentPath = join(dir, "main.jsonl");
    const subagents = join(dir, "main", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(parentPath, transcript(prompt(), tool("parent")));
    writeFileSync(join(subagents, "agent-other.jsonl"), transcript(prompt(), tool("other")));
    const timers = manualTimers();
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: parentPath, agentId: "wanted" },
      { timers: timers.timers }
    );

    await Promise.resolve();
    for (let i = 0; i < 3; i++) {
      expect(timers.pending).toBe(1);
      timers.runNext();
    }
    expect(observer.toolUseId).toBeNull();
    expect(timers.pending).toBe(1);

    writeFileSync(join(subagents, "agent-wanted.jsonl"), transcript(prompt(), tool("wanted")));
    timers.runNext();
    expect(observer.toolUseId).toBe("wanted");
    expect(await settledNow(observer.acquired)).toBeUndefined();
    observer.dispose();
  });

  test("waits for a late file, then withdraws only after the acquired tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-permission-transcript-"));
    dirs.push(dir);
    const path = join(dir, "main.jsonl");
    const timers = manualTimers();
    const observer = observePermissionTranscript({ ...context, transcriptPath: path }, { timers: timers.timers });

    await Promise.resolve();
    for (let i = 0; i < 50; i++) {
      expect(timers.pending).toBe(1);
      timers.runNext();
    }
    expect(observer.toolUseId).toBeNull();

    writeFileSync(path, transcript(prompt(), tool("late")));
    timers.runNext();
    expect(observer.toolUseId).toBe("late");
    expect(await settledNow(observer.acquired)).toBeUndefined();

    writeFileSync(path, transcript(prompt(), tool("late"), result("late")));
    timers.runNext();
    expect(timers.pending).toBe(0);
    expect(await settledNow(observer.finished)).toBe("result");
  });

  test("never adopts a completed candidate from its first complete scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-permission-transcript-"));
    dirs.push(dir);
    const path = join(dir, "main.jsonl");
    writeFileSync(path, transcript(prompt(), tool("finished"), result("finished")));
    const timers = manualTimers();
    const observer = observePermissionTranscript({ ...context, transcriptPath: path }, { timers: timers.timers });

    await Promise.resolve();
    expect(observer.toolUseId).toBeNull();
    expect(timers.pending).toBe(0);
    expect(await settledNow(observer.finished)).toBe("completed");
  });

  test("reads through short reads before rejecting competing candidates", async () => {
    const source = transcriptIo(transcript(prompt(), tool("first"), tool("second")), 7);
    const timers = manualTimers();
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/short-read.jsonl" },
      { intervalMs: 1, io: source.io, timers: timers.timers }
    );

    await Promise.resolve();
    expect(await settledNow(observer.finished)).toBe("ambiguous");
    expect(source.reads).toBeGreaterThan(2);
    expect(timers.pending).toBe(0);
  });

  test("enforces the transcript line limit", async () => {
    const source = transcriptIo(transcript(prompt(), tool("first"), tool("second")));
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/line-limit.jsonl" },
      { io: source.io, maxLines: 2 }
    );

    await Promise.resolve();
    expect(await settledNow(observer.finished)).toBe("limit");
  });

  test("reads one complete snapshot until the transcript changes", async () => {
    const source = transcriptIo(transcript(prompt(), tool("open")), 11);
    const timers = manualTimers();
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/snapshot.jsonl" },
      { intervalMs: 1, io: source.io, timers: timers.timers }
    );

    await Promise.resolve();
    expect(await settledNow(observer.acquired)).toBeUndefined();
    expect(source.readPasses).toBe(1);
    for (let i = 0; i < 3; i++) timers.runNext();
    expect(source.readPasses).toBe(1);

    source.setRaw(transcript(prompt(), tool("open"), result("open")));
    timers.runNext();
    expect(source.readPasses).toBe(2);
    expect(await settledNow(observer.finished)).toBe("result");
  });

  test("closes on same-size and growing transcript replacement", async () => {
    const initial = transcript(prompt(), tool("open"));
    const replacements = [
      transcript(prompt(), tool("next")),
      transcript(prompt(), tool("next"), { uuid: "later" }),
    ];
    for (const replacement of replacements) {
      const source = transcriptIo(initial);
      const timers = manualTimers();
      const observer = observePermissionTranscript(
        { ...context, transcriptPath: "/virtual/replaced.jsonl" },
        { intervalMs: 1, io: source.io, timers: timers.timers }
      );
      await Promise.resolve();
      expect(await settledNow(observer.acquired)).toBeUndefined();
      source.replace(replacement);
      timers.runNext();
      expect(await settledNow(observer.finished)).toBe("invalid");
      expect(timers.pending).toBe(0);
    }
  });

  test("invalidates an acquired call missing from a changed snapshot", async () => {
    const source = transcriptIo(transcript(prompt(), tool("open")));
    const timers = manualTimers();
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/rewrite.jsonl" },
      { intervalMs: 1, io: source.io, timers: timers.timers }
    );
    await Promise.resolve();
    expect(await settledNow(observer.acquired)).toBeUndefined();
    source.setRaw(transcript(prompt(), tool("next")));
    timers.runNext();
    expect(await settledNow(observer.finished)).toBe("invalid");
    expect(timers.pending).toBe(0);
  });

  test("does not run callbacks after a terminal transcript outcome", async () => {
    const cases: Array<{ raw: string; options?: { maxBytes?: number }; outcome: PermissionTranscriptOutcome }> = [
      { raw: "not json\n", outcome: "invalid" },
      { raw: transcript(prompt(), tool("one"), tool("two")), outcome: "ambiguous" },
      { raw: transcript(prompt(), tool("done"), result("done")), outcome: "completed" },
      { raw: "x".repeat(128), options: { maxBytes: 64 }, outcome: "limit" },
    ];
    for (const { raw, options, outcome } of cases) {
      const source = transcriptIo(raw);
      const timers = manualTimers();
      const observer = observePermissionTranscript(
        { ...context, transcriptPath: "/virtual/terminal.jsonl" },
        { intervalMs: 1, io: source.io, timers: timers.timers, ...options }
      );

      await Promise.resolve();
      expect(await settledNow(observer.finished)).toBe(outcome);
      const operations = source.operations;
      expect(timers.pending).toBe(0);
      await Promise.resolve();
      expect(source.operations).toBe(operations);
    }
  });

  test("clears pending callbacks after result and disposal", async () => {
    const source = transcriptIo(transcript(prompt(), tool("open")));
    const timers = manualTimers();
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/result.jsonl" },
      { intervalMs: 1, io: source.io, timers: timers.timers }
    );
    await Promise.resolve();
    expect(await settledNow(observer.acquired)).toBeUndefined();
    source.setRaw(transcript(prompt(), tool("open"), result("open")));
    timers.runNext();
    expect(await settledNow(observer.finished)).toBe("result");
    expect(timers.pending).toBe(0);

    const pendingSource = transcriptIo("");
    const pendingTimers = manualTimers();
    const pending = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/disposed.jsonl" },
      { intervalMs: 1, io: pendingSource.io, timers: pendingTimers.timers }
    );
    pending.dispose();
    expect(await settledNow(pending.finished)).toBe("disposed");
    await Promise.resolve();
    expect(pendingSource.operations).toBe(0);
    expect(pendingTimers.pending).toBe(0);
  });

  test("closes on transcript truncation", async () => {
    const source = transcriptIo(transcript(prompt(), tool("open")));
    const timers = manualTimers();
    const observer = observePermissionTranscript(
      { ...context, transcriptPath: "/virtual/truncated.jsonl" },
      { intervalMs: 1, io: source.io, timers: timers.timers }
    );
    await Promise.resolve();
    expect(await settledNow(observer.acquired)).toBeUndefined();
    source.setRaw(line(prompt()));
    timers.runNext();
    expect(await settledNow(observer.finished)).toBe("invalid");
    expect(timers.pending).toBe(0);
  });
});
