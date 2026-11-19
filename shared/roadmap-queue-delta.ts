// Relative operations on the dispatch queue of one project. The queue is a list
// of WAVES (cards sharing a rank run in parallel); an operation names cards and
// anchors, never a rank, so it replays on a queue that moved since it was
// written. Pure: the broker owns the database, the project and the preconditions.

export const QUEUE_DELTA_MAX_OPS = 500;
export const QUEUE_DELTA_MAX_IDS = 5000;
const ID_MAX_CHARS = 64;

export type QueueDeltaPlacement = { before: string } | { after: string } | { at: "start" | "end" };

export type QueueDeltaOp =
  | ({ op: "place"; ids: string[] } & QueueDeltaPlacement)
  | { op: "join"; ids: string[]; anchor: string }
  | { op: "remove"; ids: string[] }
  | { op: "clear" };

export type QueueDeltaErrorCode =
  | "malformed"
  | "too_large"
  | "unknown_anchor"
  | "anchor_moved"
  | "not_queued";

export interface QueueDeltaError {
  ok: false;
  code: QueueDeltaErrorCode;
  error: string;
  /** Index of the offending operation. */
  op_index: number;
  item_id?: string;
}

function fail(code: QueueDeltaErrorCode, error: string, op_index: number, item_id?: string): QueueDeltaError {
  return item_id === undefined ? { ok: false, code, error, op_index } : { ok: false, code, error, op_index, item_id };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX_CHARS && value === value.trim();
}

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isId)) return null;
  return new Set(value).size === value.length ? (value as string[]) : null;
}

/** Wire shape to typed operations: unknown keys and mixed placements are refused, nothing is repaired. */
export function parseQueueDeltaOps(raw: unknown): { ok: true; ops: QueueDeltaOp[] } | QueueDeltaError {
  if (!Array.isArray(raw) || raw.length === 0) return fail("malformed", "ops must be a non-empty array", 0);
  if (raw.length > QUEUE_DELTA_MAX_OPS) {
    return fail("too_large", `ops exceeds the ${QUEUE_DELTA_MAX_OPS}-operation limit`, QUEUE_DELTA_MAX_OPS);
  }
  const ops: QueueDeltaOp[] = [];
  let totalIds = 0;
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail("malformed", "an operation must be an object", i);
    }
    const o = entry as Record<string, unknown>;
    const keys = Object.keys(o);
    const only = (allowed: string[]): boolean => keys.every((k) => allowed.includes(k));
    if (o.op === "clear") {
      if (!only(["op"])) return fail("malformed", "clear takes no argument", i);
      ops.push({ op: "clear" });
      continue;
    }
    const ids = idList(o.ids);
    if (ids === null) return fail("malformed", "ids must be a non-empty list of distinct card ids", i);
    totalIds += ids.length;
    if (totalIds > QUEUE_DELTA_MAX_IDS) {
      return fail("too_large", `the operations name more than ${QUEUE_DELTA_MAX_IDS} cards`, i);
    }
    if (o.op === "remove") {
      if (!only(["op", "ids"])) return fail("malformed", "remove takes only ids", i);
      ops.push({ op: "remove", ids });
    } else if (o.op === "join") {
      if (!only(["op", "ids", "anchor"]) || !isId(o.anchor)) {
        return fail("malformed", "join takes ids and a card id anchor", i);
      }
      ops.push({ op: "join", ids, anchor: o.anchor });
    } else if (o.op === "place") {
      if (!only(["op", "ids", "before", "after", "at"])) return fail("malformed", "place has an unknown key", i);
      const given = ["before", "after", "at"].filter((k) => o[k] !== undefined);
      if (given.length !== 1) return fail("malformed", "place takes exactly one of before, after, at", i);
      if (o.before !== undefined) {
        if (!isId(o.before)) return fail("malformed", "before must be a card id", i);
        ops.push({ op: "place", ids, before: o.before });
      } else if (o.after !== undefined) {
        if (!isId(o.after)) return fail("malformed", "after must be a card id", i);
        ops.push({ op: "place", ids, after: o.after });
      } else if (o.at === "start" || o.at === "end") {
        ops.push({ op: "place", ids, at: o.at });
      } else {
        return fail("malformed", "at must be 'start' or 'end'", i);
      }
    } else {
      return fail("malformed", "op must be place, join, remove or clear", i);
    }
  }
  return { ok: true, ops };
}

/** Every card id an operation names, anchors included, for existence and permission checks. */
export function queueDeltaCardIds(ops: readonly QueueDeltaOp[]): string[] {
  const seen = new Set<string>();
  for (const op of ops) {
    if (op.op === "clear") continue;
    for (const id of op.ids) seen.add(id);
    if (op.op === "join") seen.add(op.anchor);
    if (op.op === "place" && "before" in op) seen.add(op.before);
    if (op.op === "place" && "after" in op) seen.add(op.after);
  }
  return [...seen];
}

/** The cards the operations move or remove, anchors excluded: the ones whose position a lock must protect. */
export function queueDeltaMovedIds(ops: readonly QueueDeltaOp[]): string[] {
  const seen = new Set<string>();
  for (const op of ops) {
    if (op.op === "clear") continue;
    for (const id of op.ids) seen.add(id);
  }
  return [...seen];
}

/** The waves of a queue as stored: one wave per distinct rank, ascending, ids sorted inside a wave. */
export function queueToWaves(rows: readonly { id: string; queue: number }[]): string[][] {
  const byRank = new Map<number, string[]>();
  for (const row of rows) {
    const wave = byRank.get(row.queue);
    if (wave) wave.push(row.id);
    else byRank.set(row.queue, [row.id]);
  }
  return [...byRank.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ids]) => ids.sort());
}

/** Rank per card of a wave list: wave i holds rank i + 1. */
export function wavesToRanks(waves: readonly (readonly string[])[]): Map<string, number> {
  const ranks = new Map<string, number>();
  waves.forEach((wave, i) => {
    for (const id of wave) ranks.set(id, i + 1);
  });
  return ranks;
}

function without(waves: string[][], ids: ReadonlySet<string>): string[][] {
  return waves.map((wave) => wave.filter((id) => !ids.has(id))).filter((wave) => wave.length > 0);
}

function waveIndexOf(waves: readonly (readonly string[])[], id: string): number {
  return waves.findIndex((wave) => wave.includes(id));
}

/**
 * Interprets the operations in order against a coherent state. An anchor that
 * is not queued, or that the same operation moves, is refused: it is never
 * replaced by the end of the queue. Empty waves disappear; the caller derives
 * the ranks from the returned list.
 */
export function applyQueueDelta(
  start: readonly (readonly string[])[],
  ops: readonly QueueDeltaOp[]
): { ok: true; waves: string[][] } | QueueDeltaError {
  let waves = start.map((wave) => [...wave]);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.op === "clear") {
      waves = [];
      continue;
    }
    const moving = new Set(op.ids);
    if (op.op === "remove") {
      const queued = new Set(waves.flat());
      const absent = op.ids.find((id) => !queued.has(id));
      if (absent !== undefined) return fail("not_queued", `card '${absent}' is not queued`, i, absent);
      waves = without(waves, moving);
      continue;
    }
    const anchor = op.op === "join" ? op.anchor : "before" in op ? op.before : "after" in op ? op.after : null;
    if (anchor !== null && moving.has(anchor)) {
      return fail("anchor_moved", `the anchor '${anchor}' is one of the cards being moved`, i, anchor);
    }
    waves = without(waves, moving);
    if (op.op === "join") {
      const at = waveIndexOf(waves, op.anchor);
      if (at < 0) return fail("unknown_anchor", `the anchor '${op.anchor}' is not queued`, i, op.anchor);
      waves[at] = [...waves[at]!, ...op.ids];
      continue;
    }
    if ("at" in op) {
      if (op.at === "start") waves.unshift([...op.ids]);
      else waves.push([...op.ids]);
      continue;
    }
    const target = "before" in op ? op.before : op.after;
    const at = waveIndexOf(waves, target);
    if (at < 0) return fail("unknown_anchor", `the anchor '${target}' is not queued`, i, target);
    waves.splice("before" in op ? at : at + 1, 0, [...op.ids]);
  }
  return { ok: true, waves };
}

/** Stable text of an envelope's meaning: key order and whitespace never change its hash. */
export function canonicalQueueDelta(projectKey: string, expectedQueueRev: number, ops: readonly QueueDeltaOp[]): string {
  const normalized = ops.map((op) => {
    if (op.op === "clear") return { op: "clear" };
    if (op.op === "remove") return { op: "remove", ids: op.ids };
    if (op.op === "join") return { op: "join", ids: op.ids, anchor: op.anchor };
    if ("before" in op) return { op: "place", ids: op.ids, before: op.before };
    if ("after" in op) return { op: "place", ids: op.ids, after: op.after };
    return { op: "place", ids: op.ids, at: op.at };
  });
  return JSON.stringify({ v: 1, project_key: projectKey, expected_queue_rev: expectedQueueRev, ops: normalized });
}
