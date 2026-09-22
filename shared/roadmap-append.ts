/**
 * Cap on the resulting context length in characters, not bytes -- SQLite's
 * length() counts characters here; switching to a byte count would silently
 * desync this comment and check from what the broker enforces.
 */
export const ROADMAP_APPEND_RESULT_MAX_CHARS = 16000;

/**
 * Delimiter markers wrapping each append header: \n<<< append <ISO8601> by
 * <author> >>>\n.
 * Either marker appearing in a caller's submitted text is refused outright,
 * never stripped or escaped, so a forged header cannot be smuggled in and later
 * read back as a legitimate entry.
 */
export const ROADMAP_APPEND_HEADER_OPEN = "<<<";
export const ROADMAP_APPEND_HEADER_CLOSE = ">>>";
export const ROADMAP_APPEND_BODY_TARGET = "body";

const ROADMAP_APPEND_TIMESTAMP_PATTERN = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
const ROADMAP_APPEND_TARGET_PATTERN = `(?:${ROADMAP_APPEND_BODY_TARGET}|${ROADMAP_APPEND_TIMESTAMP_PATTERN})`;
const ROADMAP_APPEND_HEADER_LINE_RE = new RegExp(
  `^${ROADMAP_APPEND_HEADER_OPEN} append (${ROADMAP_APPEND_TIMESTAMP_PATTERN}) by ([a-z0-9:_-]+)(?: supersedes (${ROADMAP_APPEND_TARGET_PATTERN}(?:, ${ROADMAP_APPEND_TARGET_PATTERN})*))? ${ROADMAP_APPEND_HEADER_CLOSE}$`,
  "gm",
);

export type RoadmapContextUnit =
  | {
      kind: "body";
      target: typeof ROADMAP_APPEND_BODY_TARGET;
      timestamp: null;
      author: null;
      supersedes: readonly string[];
      raw: string;
      length: number;
    }
  | {
      kind: "append";
      target: string;
      timestamp: string;
      author: string;
      supersedes: readonly string[];
      raw: string;
      length: number;
    };

export type RoadmapSupersedeTargetErrorCode =
  | "supersede_target_duplicate"
  | "supersede_target_missing"
  | "supersede_target_ambiguous";

export type RoadmapSupersedeTargetValidation =
  | { ok: true; targets: string[] }
  | {
      ok: false;
      code: RoadmapSupersedeTargetErrorCode;
      message: string;
    };

export function buildRoadmapAppendHeader(nowIso: string, author: string): string {
  if (arguments.length > 2) {
    throw new Error("supersession targets require planRoadmapContextAppend");
  }
  return buildValidatedRoadmapAppendHeader(nowIso, author, []);
}

function buildValidatedRoadmapAppendHeader(nowIso: string, author: string, targets: readonly string[]): string {
  const clause = targets.length === 0 ? "" : ` supersedes ${targets.join(", ")}`;
  return `\n${ROADMAP_APPEND_HEADER_OPEN} append ${nowIso} by ${author}${clause} ${ROADMAP_APPEND_HEADER_CLOSE}\n`;
}

export function normalizeRoadmapSupersedeTargets(targets: readonly string[]): string[] {
  return [...targets].sort((left, right) => {
    if (left === ROADMAP_APPEND_BODY_TARGET) return right === ROADMAP_APPEND_BODY_TARGET ? 0 : -1;
    if (right === ROADMAP_APPEND_BODY_TARGET) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function getUniqueRoadmapAppendTimestamp(context: string, nowIso: string): string {
  const targets = new Set(
    parseRoadmapContext(context)
      .filter((unit) => unit.kind === "append")
      .map((unit) => unit.target),
  );
  const timestamp = new Date(nowIso);
  while (targets.has(timestamp.toISOString())) timestamp.setTime(timestamp.getTime() + 1);
  return timestamp.toISOString();
}

export function parseRoadmapContext(context: string): RoadmapContextUnit[] {
  const headers = [...context.matchAll(ROADMAP_APPEND_HEADER_LINE_RE)].map((match) => {
    const headerIndex = match.index ?? 0;
    const start = headerIndex > 0 && context[headerIndex - 1] === "\n" ? headerIndex - 1 : headerIndex;
    return {
      start,
      timestamp: match[1] ?? "",
      author: match[2] ?? "",
      supersedes: match[3]?.split(", ") ?? [],
    };
  });
  const firstHeader = headers[0];
  const bodyRaw = context.slice(0, firstHeader?.start ?? context.length);
  const units: RoadmapContextUnit[] = [
    {
      kind: "body",
      target: ROADMAP_APPEND_BODY_TARGET,
      timestamp: null,
      author: null,
      supersedes: [],
      raw: bodyRaw,
      length: codePointLength(bodyRaw),
    },
  ];

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    const nextHeader = headers[index + 1];
    const raw = context.slice(header.start, nextHeader?.start ?? context.length);
    units.push({
      kind: "append",
      target: header.timestamp,
      timestamp: header.timestamp,
      author: header.author,
      supersedes: header.supersedes,
      raw,
      length: codePointLength(raw),
    });
  }

  return units;
}

export function resolveSupersededRoadmapContextTargets(units: readonly RoadmapContextUnit[]): Set<string> {
  const superseded = new Set<string>();
  for (const unit of units) {
    for (const target of unit.supersedes) superseded.add(target);
  }
  return superseded;
}

export function getLivingRoadmapContextUnits(context: string): RoadmapContextUnit[] {
  const units = parseRoadmapContext(context);
  const superseded = resolveSupersededRoadmapContextTargets(units);
  return units.filter((unit) => !superseded.has(unit.target));
}

export function getRoadmapContextLiveLength(context: string): number {
  return getLivingRoadmapContextUnits(context).reduce((total, unit) => total + unit.length, 0);
}

export function validateRoadmapSupersedeTargets(
  context: string,
  targets: readonly string[],
): RoadmapSupersedeTargetValidation {
  const units = parseRoadmapContext(context);
  const seen = new Set<string>();

  for (const target of targets) {
    if (seen.has(target)) {
      return {
        ok: false,
        code: "supersede_target_duplicate",
        message: `supersession target '${target}' is repeated`,
      };
    }
    seen.add(target);

    const occurrences = units.filter((unit) => unit.target === target).length;
    if (occurrences === 0) {
      return {
        ok: false,
        code: "supersede_target_missing",
        message: `supersession target '${target}' does not exist`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        code: "supersede_target_ambiguous",
        message: `supersession target '${target}' is ambiguous`,
      };
    }
  }

  return { ok: true, targets: normalizeRoadmapSupersedeTargets(targets) };
}

export function getResultingRoadmapContextLiveLength(existingContext: string, appended: string): number {
  return getRoadmapContextLiveLength(existingContext + appended);
}

function codePointLength(text: string): number {
  return [...text].length;
}

export type RoadmapAppendTextErrorCode = "empty" | "contains_delimiter";
export type RoadmapContextAppendErrorCode = RoadmapAppendTextErrorCode | RoadmapSupersedeTargetErrorCode;

export type RoadmapAppendTextPlan =
  | {
      ok: true;
      header: string;
      appended: string;
    }
  | {
      ok: false;
      code: RoadmapAppendTextErrorCode;
      message: string;
    };

export type RoadmapContextAppendPlan =
  | {
      ok: true;
      header: string;
      appended: string;
      result: string;
      resultLiveLength: number;
    }
  | {
      ok: false;
      code: RoadmapContextAppendErrorCode;
      message: string;
    };

export function planRoadmapAppendText(opts: {
  text: string;
  author: string;
  nowIso: string;
}): RoadmapAppendTextPlan {
  const { text, author, nowIso } = opts;

  if (text.trim().length === 0) {
    return { ok: false, code: "empty", message: "append text is empty" };
  }

  if (text.includes(ROADMAP_APPEND_HEADER_OPEN) || text.includes(ROADMAP_APPEND_HEADER_CLOSE)) {
    return {
      ok: false,
      code: "contains_delimiter",
      message: `append text must not contain '${ROADMAP_APPEND_HEADER_OPEN}' or '${ROADMAP_APPEND_HEADER_CLOSE}'`,
    };
  }

  const header = buildRoadmapAppendHeader(nowIso, author);
  return { ok: true, header, appended: header + text };
}

export function planRoadmapContextAppend(opts: {
  existingContext: string;
  text: string;
  author: string;
  nowIso: string;
  supersedes?: readonly string[];
}): RoadmapContextAppendPlan {
  const textPlan = planRoadmapAppendText(opts);
  if (!textPlan.ok) return textPlan;

  const validation = validateRoadmapSupersedeTargets(opts.existingContext, opts.supersedes ?? []);
  if (!validation.ok) return validation;

  const header = buildValidatedRoadmapAppendHeader(opts.nowIso, opts.author, validation.targets);
  const appended = header + opts.text;
  const result = opts.existingContext + appended;
  return {
    ok: true,
    header,
    appended,
    result,
    resultLiveLength: getResultingRoadmapContextLiveLength(opts.existingContext, appended),
  };
}
