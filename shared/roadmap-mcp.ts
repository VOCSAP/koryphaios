import {
  formatRoadmapContextDocumentHeader,
  formatRoadmapContextDocumentOmission,
  ROADMAP_ADD_ACK_FIELDS,
  ROADMAP_CONTEXT_DOCUMENT_OUTPUT_MAX_CHARS,
  ROADMAP_UPDATE_ACK_FIELDS,
  ROADMAP_UPSERT_ACK_FIELDS,
  type RoadmapArchiveResponse,
  type RoadmapContextAppendResponse,
  type RoadmapContextDocument,
  type RoadmapContextDocumentListResponse,
  type RoadmapContextDocumentOmissions,
  type RoadmapItem,
  type RoadmapListResponse,
  type RoadmapUpsertAckField,
  type RoadmapUpsertResponse,
} from "./types.ts";
import {
  buildRoadmapAppendHeader,
  getLivingRoadmapContextUnits,
  getRoadmapContextLiveLength,
  parseRoadmapContext,
} from "./roadmap-append.ts";
import { queuedItems, wavesOf } from "../desktop/src/shared/workflow.ts";
import { coreLogDir, createLogger } from "./logger.ts";

const log = createLogger({ dir: coreLogDir(), name: "server", mirrorToConsole: false }).child("roadmap-mcp");

export const ROADMAP_INSTRUCTIONS = `SHARED ROADMAP: a persistent backlog (features, bugs, debt, ideas) scoped to this repository and shared with every Claude instance working on it, now and later.
- Start of a task: roadmap_list with a filter, to see what is planned and in progress.
- Bug, debt or idea outside your task: roadmap_add, with the 'context' field filled.
- Keep the status of items you work on current (roadmap_update: planned -> in_progress -> done). in_progress LOCKS the item under your peer_id: set it only when you really start, set it back to planned if you stop before finishing.
- Team leads: a kind='directive' card (roadmap_add) lets the Deck reset a peer's context between items; queue it for a lead tile to run.
- Set triage to say who the card awaits, separately from status and priority; ready-for-agent means it is specified enough to take without a human question, while needs-info awaits one.
- Find executable work with roadmap_list triages:["ready-for-agent"].`;

export interface RoadmapMcpIdentity {
  peerId: string;
  instanceToken?: string;
  projectKey: string;
}

export interface RoadmapMcpContext {
  identity: RoadmapMcpIdentity;
  brokerFetch: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
}

export interface RoadmapMcpResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

async function resolveRoadmapId(idOrPrefix: string, context: RoadmapMcpContext): Promise<string> {
  const needle = idOrPrefix.trim();
  if (!needle) throw new Error("empty id");
  const { items } = await context.brokerFetch<RoadmapListResponse>("/roadmap/list", {
    project_key: context.identity.projectKey,
    include_archived: true,
  });
  const exact = items.find((item) => item.id === needle);
  if (exact) return exact.id;
  const matches = items.filter((item) => item.id.startsWith(needle));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new Error(`no roadmap item matches '${needle}'`);
  throw new Error(`ambiguous id prefix '${needle}' (${matches.length} matches) -- use more characters`);
}

const LOCK_CONTESTED_SHOWN = 3;

export function formatLockContestedBy(contested: readonly string[] | undefined): string {
  if (!Array.isArray(contested) || contested.length === 0) return "";
  const shown = contested.slice(0, LOCK_CONTESTED_SHOWN);
  const hidden = contested.length - shown.length;
  return `${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

export function formatRoadmapItemLine(item: RoadmapItem): string {
  const tags = item.tags.length ? `  #${item.tags.join(" #")}` : "";
  const lock = item.locked ? ` 🔒${item.locked_by ?? ""}` : "";
  const contested = formatLockContestedBy(item.lock_contested_by);
  const alsoHeld = contested ? ` [also held elsewhere: ${contested}]` : "";
  const inactive = item.inactive ? " [INACTIVE -- do not claim]" : "";
  const queueRank = item.queue !== null ? ` queue:${item.queue}` : "";
  const triage = item.triage !== null ? ` triage:${item.triage}` : "";
  return `[${item.id.slice(0, 8)}] ${item.kind} · ${item.priority} · value:${item.value} effort:${item.effort} · ${item.status}${triage}${queueRank}${lock}${alsoHeld}${inactive} — ${item.title}${tags}`;
}

function formatRoadmapQueueOrder(items: RoadmapItem[]): string {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const ordered = queuedItems(items);
  const waves = wavesOf(ordered);
  const waveBlocks = waves.map((waveIds, index) => {
    const rows = waveIds.map((id) => formatRoadmapItemLine(byId.get(id)!));
    return `WAVE ${index + 1} (${rows.length} card${rows.length > 1 ? "s" : ""}, dispatched together):\n${rows.join("\n")}`;
  });
  const queuedIds = new Set(ordered.map((item) => item.id));
  const rest = items.filter((item) => !queuedIds.has(item.id));
  const parts = [
    waveBlocks.length
      ? `DISPATCH QUEUE (${ordered.length} card(s) in ${waves.length} wave(s)):\n\n${waveBlocks.join("\n\n")}`
      : "DISPATCH QUEUE: empty.",
  ];
  if (rest.length) parts.push(`NOT QUEUED (${rest.length}):\n${rest.map(formatRoadmapItemLine).join("\n")}`);
  return parts.join("\n\n");
}

function formatRoadmapContext(context: string, rawContext: boolean): string {
  if (rawContext) return `context (raw agent briefing): ${context}`;
  const livingUnits = getLivingRoadmapContextUnits(context);
  const livingTargets = new Set(livingUnits.map((unit) => unit.target));
  const supersededUnits = parseRoadmapContext(context).filter((unit) => !livingTargets.has(unit.target));
  const lines = [
    `context (living, ${getRoadmapContextLiveLength(context)} chars): ${livingUnits.map((unit) => unit.raw).join("")}`,
  ];
  if (supersededUnits.length > 0) {
    lines.push(`context superseded: ${supersededUnits.length} unit(s): ${supersededUnits.map((unit) => unit.timestamp ?? "body").join(", ")}`);
  }
  return lines.join("\n");
}

function formatRoadmapContextDocuments(
  documents: readonly RoadmapContextDocument[],
  omitted?: RoadmapContextDocumentOmissions,
): string {
  const rendered = documents.map(
    (document) => `${formatRoadmapContextDocumentHeader(document)}\n${document.units.map((unit) => unit.raw).join("")}`,
  );
  if (omitted && omitted.document_count > 0) rendered.push(formatRoadmapContextDocumentOmission(omitted));
  const section = rendered.join("\n\n");
  if (section.length > ROADMAP_CONTEXT_DOCUMENT_OUTPUT_MAX_CHARS) {
    throw new Error("context document section exceeds its output budget");
  }
  return section;
}

function formatRoadmapItemDetail(
  item: RoadmapItem,
  rawContext = false,
  documentCount = 0,
  documents?: readonly RoadmapContextDocument[],
  omittedDocuments?: RoadmapContextDocumentOmissions,
): string {
  const lines = [
    formatRoadmapItemLine(item),
    `id: ${item.id}`,
    item.description ? `description: ${item.description}` : "",
    item.rationale ? `rationale: ${item.rationale}` : "",
    item.context ? formatRoadmapContext(item.context, rawContext) : "",
    documents
      ? formatRoadmapContextDocuments(documents, omittedDocuments)
      : documentCount > 0
        ? `context documents available: ${documentCount}; call roadmap_get with with_documents: true to read them.`
        : "",
    item.kind === "directive"
      ? `directive: /${item.directive} -> ${item.target_peer_ids.length ? item.target_peer_ids.join(", ") : "(no targets yet)"} (executed by the Deck when dispatched)`
      : "",
    item.depends_on.length ? `depends_on: ${item.depends_on.map((id) => id.slice(0, 8)).join(", ")}` : "",
    item.triage !== null ? `triage: ${item.triage} (who the card waits on)` : "triage: not triaged yet",
    item.locked ? `locked: by ${item.locked_by} since ${item.locked_at} (actively being worked on)` : "",
    item.inactive ? "inactive: this card is inactive -- do not claim it or move it to in_progress; only an operator-signed write can clear this" : "",
    `created: ${item.created_at} by ${item.created_by}`,
    `updated: ${item.updated_at} by ${item.updated_by}`,
    item.deleted_at ? `archived: ${item.deleted_at}` : "",
  ].filter(Boolean);
  return lines.join("\n  ");
}

function formatLockedAtHHMM(lockedAt: string): string {
  const match = lockedAt.match(/[ T](\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : lockedAt;
}

export function formatRoadmapUpsertAck(opts: {
  label: "created" | "updated";
  item: RoadmapItem;
  args: Record<string, unknown>;
  domain: readonly RoadmapUpsertAckField[];
  holderInstanceToken?: string;
}): string {
  const { label, item, args, domain, holderInstanceToken } = opts;
  const passed: string[] = [];
  const untouched: string[] = [];
  for (const field of domain) {
    if (args[field] === undefined) {
      untouched.push(field);
      continue;
    }
    const spec = ROADMAP_UPSERT_ACK_FIELDS[field];
    if (spec.category === "intent") {
      if (args[field] === true) passed.push(`${field} requested`);
      else untouched.push(field);
      continue;
    }
    const landed = spec.landed(item);
    if (spec.category === "long") {
      const requestedArg = args[field];
      const requestedLen = typeof requestedArg === "string" ? requestedArg.length : String(requestedArg).length;
      const landedLen = typeof landed === "string" ? landed.length : String(landed).length;
      passed.push(`${field}: requested ${requestedLen} chars, landed ${landedLen} chars`);
    } else if (spec.category === "list") {
      const landedCount = Array.isArray(landed) ? landed.length : 0;
      const requestedArg = args[field];
      const requestedCount = Array.isArray(requestedArg) ? requestedArg.length : 0;
      const suffix = requestedCount !== landedCount ? ` (requested ${requestedCount})` : "";
      passed.push(`${field} -> ${landedCount} item(s)${suffix}`);
    } else {
      const landedStr = String(landed);
      const requestedStr = String(args[field]);
      const suffix = requestedStr !== landedStr ? ` (requested ${requestedStr})` : "";
      passed.push(`${field} -> ${landedStr}${suffix}`);
    }
  }
  const passedLabel = label === "created" ? "set" : "changed";
  const untouchedLabel = label === "created" ? "defaults" : "unchanged";
  const lines = [`Roadmap item ${label}: ${item.id.slice(0, 8)}`];
  if (passed.length) lines.push(`  ${passedLabel}: ${passed.join(", ")}`);
  if (untouched.length) lines.push(`  ${untouchedLabel}: ${untouched.join(", ")}`);
  if (holderInstanceToken !== undefined && item.locked_by_token !== null && item.locked_by_token === holderInstanceToken) {
    const since = item.locked_at !== null ? formatLockedAtHHMM(item.locked_at) : "an unknown time";
    lines.push(`  you hold this card's work-lock (since ${since}) -- if only your own part is done, pass locked:false while leaving status:in_progress so the card stays claimed for the rest`);
  }
  const contested = formatLockContestedBy(item.lock_contested_by);
  if (contested) lines.push(`  work-lock also held elsewhere: ${contested}`);
  return lines.join("\n");
}

function formatRoadmapAppendAck(requestedText: string, author: string, item: RoadmapItem): string {
  const landed = ROADMAP_UPSERT_ACK_FIELDS.context.landed(item);
  const landedLen = typeof landed === "string" ? landed.length : String(landed).length;
  const headerLen = buildRoadmapAppendHeader(new Date().toISOString(), author).length;
  const appendedLen = headerLen + requestedText.length;
  return [
    `Roadmap item context appended: ${item.id.slice(0, 8)}`,
    `  appended ${appendedLen} chars (header included), context now ${landedLen} chars`,
  ].join("\n");
}

function roadmapToolError(error: unknown): RoadmapMcpResult {
  return {
    content: [{ type: "text", text: `Roadmap error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

export async function callRoadmapTool(
  name: string,
  args: Record<string, unknown>,
  context: RoadmapMcpContext,
): Promise<RoadmapMcpResult> {
  const { identity, brokerFetch } = context;
  const proof = identity.instanceToken ? { instance_token: identity.instanceToken } : {};
  try {
    switch (name) {
      case "roadmap_list": {
        const a = args as {
          kind?: string;
          status?: string;
          priority?: string;
          tag?: string;
          include_archived?: boolean;
          kinds?: string[];
          statuses?: string[];
          priorities?: string[];
          efforts?: string[];
          values?: string[];
          triages?: string[];
          tags?: string[];
          q?: string;
          q_deep?: boolean;
          order?: string;
        };
        const { items } = await brokerFetch<RoadmapListResponse>("/roadmap/list", {
          project_key: identity.projectKey,
          kind: a.kind,
          status: a.status,
          priority: a.priority,
          tag: a.tag,
          include_archived: a.include_archived ?? false,
          kinds: a.kinds,
          statuses: a.statuses,
          priorities: a.priorities,
          efforts: a.efforts,
          values: a.values,
          triages: a.triages,
          tags: a.tags,
          q: a.q,
          q_deep: a.q_deep,
        });
        if (items.length === 0) {
          return {
            content: [{ type: "text", text: "The roadmap is empty (for these filters). Use roadmap_add to record features, bugs, debt or ideas." }],
          };
        }
        const body = a.order === "queue"
          ? formatRoadmapQueueOrder(items)
          : (["must", "should", "could", "wont"] as const)
              .map((priority) => {
                const rows = items.filter((item) => item.priority === priority);
                return rows.length ? `${priority.toUpperCase()} (${rows.length}):\n${rows.map(formatRoadmapItemLine).join("\n")}` : "";
              })
              .filter(Boolean)
              .join("\n\n");
        return {
          content: [{ type: "text", text: `${items.length} roadmap item(s):\n\n${body}\n\nUse roadmap_get <id> for details, roadmap_update to change status.` }],
        };
      }
      case "roadmap_get": {
        const a = args as { id: string; raw_context?: boolean; with_documents?: boolean };
        const id = await resolveRoadmapId(a.id, context);
        const { items } = await brokerFetch<RoadmapListResponse>("/roadmap/list", {
          project_key: identity.projectKey,
          include_archived: true,
        });
        const item = items.find((candidate) => candidate.id === id);
        if (!item) throw new Error(`item ${id} vanished`);
        const documentList = await brokerFetch<RoadmapContextDocumentListResponse>("/roadmap/context-document/list", {
          id,
          project_key: identity.projectKey,
          include_documents: a.with_documents === true,
        });
        if (a.with_documents === true && !documentList.documents) {
          throw new Error("context document read returned no documents");
        }
        const omittedDocuments = documentList.omitted_document_count === undefined
          ? undefined
          : {
              document_count: documentList.omitted_document_count,
              document_ids: documentList.omitted_document_ids ?? [],
            };
        return {
          content: [{
            type: "text",
            text: formatRoadmapItemDetail(
              item,
              a.raw_context === true,
              documentList.document_count,
              documentList.documents,
              omittedDocuments,
            ),
          }],
        };
      }
      case "roadmap_add": {
        const a = args as Record<string, unknown> & { title: string };
        const { item } = await brokerFetch<RoadmapUpsertResponse>("/roadmap/upsert", {
          project_key: identity.projectKey,
          by: identity.peerId,
          ...proof,
          title: a.title,
          kind: a.kind,
          description: a.description,
          rationale: a.rationale,
          context: a.context,
          priority: a.priority,
          value: a.value,
          effort: a.effort,
          status: a.status,
          triage: a.triage,
          tags: a.tags,
          depends_on: a.depends_on,
          directive: a.directive,
          target_peer_ids: a.target_peer_ids,
        });
        return {
          content: [{
            type: "text",
            text: formatRoadmapUpsertAck({
              label: "created",
              item,
              args: a,
              domain: ROADMAP_ADD_ACK_FIELDS,
              holderInstanceToken: identity.instanceToken,
            }),
          }],
        };
      }
      case "roadmap_update": {
        const a = args as Record<string, unknown> & { id: string };
        const id = await resolveRoadmapId(a.id, context);
        const { item } = await brokerFetch<RoadmapUpsertResponse>("/roadmap/upsert", {
          id,
          by: identity.peerId,
          ...proof,
          title: a.title,
          kind: a.kind,
          description: a.description,
          rationale: a.rationale,
          context: a.context,
          priority: a.priority,
          value: a.value,
          effort: a.effort,
          status: a.status,
          triage: a.triage,
          tags: a.tags,
          depends_on: a.depends_on,
          directive: a.directive,
          target_peer_ids: a.target_peer_ids,
          locked: typeof a.locked === "boolean" ? a.locked : undefined,
          release: a.release,
          queue: a.queue,
        });
        return {
          content: [{
            type: "text",
            text: formatRoadmapUpsertAck({
              label: "updated",
              item,
              args: a,
              domain: ROADMAP_UPDATE_ACK_FIELDS,
              holderInstanceToken: identity.instanceToken,
            }),
          }],
        };
      }
      case "roadmap_archive": {
        const a = args as { id: string };
        const id = await resolveRoadmapId(a.id, context);
        const { item } = await brokerFetch<RoadmapArchiveResponse>("/roadmap/archive", {
          id,
          by: identity.peerId,
          ...proof,
        });
        return {
          content: [{ type: "text", text: `Roadmap item archived (restorable via roadmap_update status):\n${formatRoadmapItemLine(item)}` }],
        };
      }
      case "roadmap_append_context": {
        const a = args as { id: string; text: string; supersedes?: string[] };
        const id = await resolveRoadmapId(a.id, context);
        const { item } = await brokerFetch<RoadmapContextAppendResponse>("/roadmap/append-context", {
          id,
          by: identity.peerId,
          ...proof,
          text: a.text,
          supersedes: a.supersedes,
        });
        return { content: [{ type: "text", text: formatRoadmapAppendAck(a.text, identity.peerId, item) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    log.error(`Roadmap tool ${name} failed`, error);
    return roadmapToolError(error);
  }
}
