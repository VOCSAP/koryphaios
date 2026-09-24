import type { Database } from "bun:sqlite";
import {
  getUniqueRoadmapAppendTimestamp,
  parseRoadmapContext,
  planRoadmapContextAppend,
  ROADMAP_APPEND_RESULT_MAX_CHARS,
  validateRoadmapSupersedeTargets,
} from "./roadmap-append.ts";
import type {
  RoadmapContextDocument,
  RoadmapContextDocumentUnit,
} from "./types.ts";

export const ROADMAP_CONTEXT_DOCUMENT_CAS_ATTEMPTS = 4;
export const MAX_CONTEXT_DOCUMENT_UNITS = 64;
export const MAX_CONTEXT_DOCUMENT_TOTAL_CHARS = 65_536;

export type RoadmapContextDocumentLimitFailure =
  | { ok: false; code: "document_too_many_units"; message: string }
  | { ok: false; code: "document_total_too_large"; message: string };

export function validateRoadmapContextDocumentLimits(
  units: readonly RoadmapContextDocumentUnit[],
): { ok: true } | RoadmapContextDocumentLimitFailure {
  if (units.length > MAX_CONTEXT_DOCUMENT_UNITS) {
    return {
      ok: false,
      code: "document_too_many_units",
      message: `context document exceeds MAX_CONTEXT_DOCUMENT_UNITS (${MAX_CONTEXT_DOCUMENT_UNITS})`,
    };
  }
  const totalChars = units.reduce((total, unit) => total + unit.raw.length, 0);
  if (totalChars > MAX_CONTEXT_DOCUMENT_TOTAL_CHARS) {
    return {
      ok: false,
      code: "document_total_too_large",
      message: `context document exceeds MAX_CONTEXT_DOCUMENT_TOTAL_CHARS (${MAX_CONTEXT_DOCUMENT_TOTAL_CHARS})`,
    };
  }
  return { ok: true };
}

export type RoadmapContextDocumentCasRow = {
  context: string | null;
  contentRev: number;
};

export type RoadmapContextDocumentCasWrite = {
  id: string;
  expectedContentRev: number;
  context: string;
  operatorId: string | null;
  document: RoadmapContextDocument;
};

export type RoadmapContextDocumentCasStore = {
  read(id: string): RoadmapContextDocumentCasRow | null;
  replace(write: RoadmapContextDocumentCasWrite): boolean;
};

export type RoadmapContextDocumentDeportResult =
  | { ok: true; document: RoadmapContextDocument; context: string }
  | {
      ok: false;
      code:
        | "unknown_roadmap_item"
        | "concurrent_change"
        | "targets_required"
        | "invalid_document_text"
        | "selected_unit_supersedes_remaining"
        | "living_context_too_large"
        | "document_too_many_units"
        | "document_total_too_large";
      message: string;
    }
  | { ok: false; code: "supersede_target_duplicate" | "supersede_target_missing" | "supersede_target_ambiguous"; message: string };

export function isValidRoadmapContextDocumentText(text: string): boolean {
  return !text.includes("\0") && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text)) === text;
}

function planRoadmapContextDocumentDeport(opts: {
  context: string;
  targets: readonly string[];
  author: string;
  documentId: string;
  nowIso: string;
  nextId: () => string;
}): Exclude<RoadmapContextDocumentDeportResult, { ok: true }> | { ok: true; document: RoadmapContextDocument; context: string } {
  if (opts.targets.length === 0) {
    return { ok: false, code: "targets_required", message: "at least one context target is required" };
  }

  const validation = validateRoadmapSupersedeTargets(opts.context, opts.targets);
  if (!validation.ok) return validation;

  const selectedTargets = new Set(validation.targets);
  const units = parseRoadmapContext(opts.context);
  const selected = units.filter((unit) => selectedTargets.has(unit.target));
  const remaining = units.filter((unit) => !selectedTargets.has(unit.target));
  const emptyUnit = selected.find((unit) => unit.raw.length === 0);
  if (emptyUnit) {
    return {
      ok: false,
      code: "supersede_target_missing",
      message: `supersession target '${emptyUnit.target}' does not exist in current context`,
    };
  }
  const remainingTargets = new Set(remaining.map((unit) => unit.target));
  const supersedingUnit = selected.find((unit) => unit.supersedes.some((target) => remainingTargets.has(target)));
  if (supersedingUnit) {
    return {
      ok: false,
      code: "selected_unit_supersedes_remaining",
      message: `selected context unit '${supersedingUnit.target}' supersedes a unit that remains in context`,
    };
  }
  if (selected.some((unit) => !isValidRoadmapContextDocumentText(unit.raw))) {
    return {
      ok: false,
      code: "invalid_document_text",
      message: "selected context units must be valid UTF-8 text without a NUL byte",
    };
  }

  const remainingContext = remaining.map((unit) => unit.raw).join("");
  const timestamp = getUniqueRoadmapAppendTimestamp(remainingContext, opts.nowIso);
  const link = planRoadmapContextAppend({
    existingContext: remainingContext,
    text: `Context document ${opts.documentId}`,
    author: opts.author,
    nowIso: timestamp,
  });
  if (!link.ok) {
    return { ok: false, code: "invalid_document_text", message: link.message };
  }
  if (link.resultLiveLength > ROADMAP_APPEND_RESULT_MAX_CHARS) {
    return {
      ok: false,
      code: "living_context_too_large",
      message: `context document link would exceed the ${ROADMAP_APPEND_RESULT_MAX_CHARS}-char living-context cap`,
    };
  }

  const createdAt = opts.nowIso;
  const document: RoadmapContextDocument = {
    id: opts.documentId,
    roadmap_item_id: "",
    project_key: "",
    created_by: opts.author,
    created_at: createdAt,
    units: selected.map((unit, position): RoadmapContextDocumentUnit => ({
      id: opts.nextId(),
      source_target: unit.target,
      raw: unit.raw,
      deported_at: createdAt,
      position,
    })),
  };
  const limits = validateRoadmapContextDocumentLimits(document.units);
  if (!limits.ok) return limits;
  return { ok: true, document, context: link.result };
}

export function createSqliteRoadmapContextDocumentCasStore(
  db: Pick<Database, "query" | "run" | "transaction" | "prepare">,
): RoadmapContextDocumentCasStore {
  const replace = db.transaction((write: RoadmapContextDocumentCasWrite): boolean => {
    const updated = db.run(
      `UPDATE roadmap_items
          SET context = ?,
              operator_id = COALESCE(?, operator_id)
        WHERE id = ? AND content_rev = ?`,
      [write.context, write.operatorId, write.id, write.expectedContentRev],
    );
    if (updated.changes === 0) return false;

    db.run(
      `INSERT INTO roadmap_context_documents
         (id, roadmap_item_id, project_key, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        write.document.id,
        write.document.roadmap_item_id,
        write.document.project_key,
        write.document.created_by,
        write.document.created_at,
      ],
    );
    const insertUnit = db.prepare(
      `INSERT INTO roadmap_context_document_units
         (id, document_id, source_target, raw, deported_at, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const unit of write.document.units) {
      insertUnit.run(
        unit.id,
        write.document.id,
        unit.source_target,
        unit.raw,
        unit.deported_at,
        unit.position,
      );
    }
    return true;
  });

  return {
    read(id) {
      const row = db.query("SELECT context, content_rev FROM roadmap_items WHERE id = ?").get(id) as
        | { context: string | null; content_rev: number }
        | null;
      return row ? { context: row.context, contentRev: row.content_rev } : null;
    },
    replace,
  };
}

export function runRoadmapContextDocumentDeportCas(opts: {
  id: string;
  projectKey: string;
  targets: readonly string[];
  author: string;
  operatorId?: string | null;
  now: () => string;
  nextId: () => string;
  store: RoadmapContextDocumentCasStore;
}): RoadmapContextDocumentDeportResult {
  const documentId = opts.nextId();
  for (let attempt = 0; attempt < ROADMAP_CONTEXT_DOCUMENT_CAS_ATTEMPTS; attempt += 1) {
    const row = opts.store.read(opts.id);
    if (!row) return { ok: false, code: "unknown_roadmap_item", message: "unknown roadmap item" };

    const plan = planRoadmapContextDocumentDeport({
      context: row.context ?? "",
      targets: opts.targets,
      author: opts.author,
      documentId,
      nowIso: opts.now(),
      nextId: opts.nextId,
    });
    if (!plan.ok) return plan;

    const document: RoadmapContextDocument = {
      ...plan.document,
      roadmap_item_id: opts.id,
      project_key: opts.projectKey,
    };
    if (
      opts.store.replace({
        id: opts.id,
        expectedContentRev: row.contentRev,
        context: plan.context,
        operatorId: opts.operatorId ?? null,
        document,
      })
    ) {
      return { ok: true, document, context: plan.context };
    }
  }

  return {
    ok: false,
    code: "concurrent_change",
    message: "card content changed concurrently (content_rev); retry the document deportation",
  };
}
