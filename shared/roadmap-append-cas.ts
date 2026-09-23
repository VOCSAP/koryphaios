import type { Database } from "bun:sqlite";
import {
  getLivingRoadmapContextUnits,
  getUniqueRoadmapAppendTimestamp,
  parseRoadmapContext,
  planRoadmapContextAppend,
  ROADMAP_APPEND_RESULT_MAX_CHARS,
  type RoadmapContextAppendPlan,
} from "./roadmap-append.ts";

export const ROADMAP_APPEND_RAW_RESULT_MAX_CHARS = 64000;
export const ROADMAP_APPEND_CAS_ATTEMPTS = 4;

type SuccessfulRoadmapContextAppendPlan = Extract<RoadmapContextAppendPlan, { ok: true }>;

export type RoadmapContextAppendCasRow = {
  context: string | null;
  contentRev: number;
};

export type RoadmapContextAppendCasWrite = {
  id: string;
  expectedContentRev: number;
  appended: string;
  operatorId: string | null;
};

export type RoadmapContextAppendCasStore = {
  read(id: string): RoadmapContextAppendCasRow | null;
  append(write: RoadmapContextAppendCasWrite): boolean;
};

export type RoadmapContextAppendCasResult =
  | { ok: true; plan: SuccessfulRoadmapContextAppendPlan }
  | { ok: false; code: "unknown_roadmap_item" }
  | { ok: false; code: "concurrent_change" }
  | { ok: false; code: "live_cap"; plan: SuccessfulRoadmapContextAppendPlan; existingContext: string }
  | { ok: false; code: "raw_cap"; plan: SuccessfulRoadmapContextAppendPlan }
  | Exclude<RoadmapContextAppendPlan, { ok: true }>;

function describeOldestLivingRoadmapContextUnits(context: string): string {
  const targetCounts = new Map<string, number>();
  for (const unit of parseRoadmapContext(context)) {
    targetCounts.set(unit.target, (targetCounts.get(unit.target) ?? 0) + 1);
  }
  const describedTargets = new Set<string>();
  return getLivingRoadmapContextUnits(context)
    .filter((unit) => unit.length > 0 && targetCounts.get(unit.target) === 1 && !describedTargets.has(unit.target))
    .slice(0, 3)
    .map((unit) => {
      describedTargets.add(unit.target);
      return `target=${unit.target}; timestamp=${unit.timestamp ?? "none"}; size=${unit.length} chars`;
    })
    .join(" | ");
}

function unreachableRoadmapContextAppendFailure(code: never): never {
  throw new Error(`unhandled roadmap context append failure: ${code}`);
}

export function mapRoadmapContextAppendFailure(
  result: Exclude<RoadmapContextAppendCasResult, { ok: true }>,
  itemExists: boolean,
): { error: string; status: 400 | 404 | 409 } {
  const code = result.code;
  switch (code) {
    case "unknown_roadmap_item":
      return { error: "unknown roadmap item", status: 404 };
    case "concurrent_change":
      return itemExists
        ? { error: "card content changed concurrently (content_rev); retry the append", status: 409 }
        : { error: "unknown roadmap item", status: 404 };
    case "live_cap":
      return {
        error:
          `append would push living context over the ${ROADMAP_APPEND_RESULT_MAX_CHARS}-char cap. ` +
          `Oldest living units: ${describeOldestLivingRoadmapContextUnits(result.existingContext)}. ` +
          "Supersede those targets in this append through `supersedes`, or move material to a child roadmap card and leave its id8 pointer in context.",
        status: 409,
      };
    case "raw_cap":
      return {
        error:
          `append would push raw context over the ${ROADMAP_APPEND_RAW_RESULT_MAX_CHARS}-char safety cap. ` +
          "Move material to a child roadmap card and leave its id8 pointer in context.",
        status: 409,
      };
    case "empty":
    case "contains_delimiter":
    case "supersede_target_duplicate":
    case "supersede_target_missing":
    case "supersede_target_ambiguous":
      return { error: result.message, status: 400 };
  }
  return unreachableRoadmapContextAppendFailure(code);
}

export function createSqliteRoadmapContextAppendCasStore(
  db: Pick<Database, "query" | "run">,
): RoadmapContextAppendCasStore {
  return {
    read(id) {
      const row = db.query("SELECT context, content_rev FROM roadmap_items WHERE id = ?").get(id) as
        | { context: string | null; content_rev: number }
        | null;
      if (!row) return null;
      return { context: row.context, contentRev: row.content_rev };
    },
    append({ id, expectedContentRev, appended, operatorId }) {
      const result = db.run(
        `UPDATE roadmap_items
            SET context = COALESCE(context,'') || ?,
                operator_id = COALESCE(?, operator_id)
          WHERE id = ? AND content_rev = ?`,
        [appended, operatorId, id, expectedContentRev],
      );
      return result.changes > 0;
    },
  };
}

export function runRoadmapContextAppendCas(opts: {
  id: string;
  author: string;
  text: string;
  supersedes?: readonly string[];
  operatorId?: string | null;
  now: () => string;
  store: RoadmapContextAppendCasStore;
}): RoadmapContextAppendCasResult {
  for (let attempt = 0; attempt < ROADMAP_APPEND_CAS_ATTEMPTS; attempt += 1) {
    const row = opts.store.read(opts.id);
    if (!row) return { ok: false, code: "unknown_roadmap_item" };

    const existingContext = row.context ?? "";
    const plan = planRoadmapContextAppend({
      existingContext,
      text: opts.text,
      author: opts.author,
      nowIso: getUniqueRoadmapAppendTimestamp(existingContext, opts.now()),
      supersedes: opts.supersedes,
    });
    if (!plan.ok) return plan;
    if (plan.resultLiveLength > ROADMAP_APPEND_RESULT_MAX_CHARS) {
      return { ok: false, code: "live_cap", plan, existingContext };
    }
    if ([...plan.result].length > ROADMAP_APPEND_RAW_RESULT_MAX_CHARS) {
      return { ok: false, code: "raw_cap", plan };
    }
    if (
      opts.store.append({
        id: opts.id,
        expectedContentRev: row.contentRev,
        appended: plan.appended,
        operatorId: opts.operatorId ?? null,
      })
    ) {
      return { ok: true, plan };
    }
  }

  return { ok: false, code: "concurrent_change" };
}
