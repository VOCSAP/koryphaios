export const ROADMAP_TOOLS = [
  {
    name: "roadmap_list",
    description:
      "List the project's shared roadmap (persistent backlog scoped to this repository, shared across sessions). Always pass a filter (statuses, kinds, q ...) so you do not load the whole board. Within a filter: OR; between filters: AND. Archived items hidden unless include_archived.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kinds: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["feature", "bug", "debt", "idea", "chore", "directive"] },
        },
        statuses: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["idea", "planned", "in_progress", "done", "archived"] },
        },
        priorities: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["must", "should", "could", "wont"] },
        },
        efforts: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["low", "medium", "high"] },
        },
        values: {
          type: "array" as const,
          items: { type: "string" as const, enum: ["low", "medium", "high"] },
        },
        triages: {
          type: "array" as const,
          items: {
            type: "string" as const,
            enum: ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"],
          },
        },
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Items carrying at least one of these tags.",
        },
        q: {
          type: "string" as const,
          description: "Free-text search over title, description and tags (order, case and accents ignored).",
        },
        q_deep: {
          type: "boolean" as const,
          description: "Widen `q` to rationale and context.",
        },
        include_archived: { type: "boolean" as const, description: "Default false." },
        order: {
          type: "string" as const,
          enum: ["queue"],
          description: "queue: real dispatch order (queue ascending, waves grouped) instead of MoSCoW groups.",
        },
      },
    },
  },
  {
    name: "roadmap_get",
    description:
      "Show the full detail of one roadmap item (description, rationale, tags, dependencies, authorship). Accepts a full id or a unique prefix (e.g. the 8-char id shown by roadmap_list).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
        raw_context: { type: "boolean" as const, description: "Return the raw context without folding superseded units." },
        with_documents: {
          type: "boolean" as const,
          description: "Include immutable context documents when this card has them. Default false.",
        },
      },
      required: ["id"],
    },
  },
  // Directive cards run when reached at the head of the dispatch queue: the
  // Deck types the command into target_peer_ids' terminals, agents never invoke
  // it themselves.
  // 'clear' resets a peer's context for free and keeps system prompt, CLAUDE.md
  // and MCP; 'compact' costs one inference; 'magic_compact' is the
  // deterministic plugin, falling back to compact.
  {
    name: "roadmap_add",
    description:
      "Add an item to the project's shared roadmap: a feature, bug, tech debt or idea you want to survive this session. Only title is required (defaults: kind=feature, priority=could, value/effort=medium, status=idea). Always fill `context`. kind='directive' is a control card the Deck executes on target_peer_ids (team leads only).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short imperative title." },
        kind: {
          type: "string" as const,
          enum: ["feature", "bug", "debt", "idea", "chore", "directive"],
          description: "Default feature.",
        },
        directive: {
          type: "string" as const,
          enum: ["clear", "compact", "magic_compact"],
          description:
            "REQUIRED when kind='directive': clear (free context reset), compact (one inference), magic_compact (plugin, falls back to compact).",
        },
        target_peer_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "kind='directive' only: peer_ids (from list_peers) that receive the command. Max 16 per card.",
        },
        description: { type: "string" as const, description: "Free markdown details." },
        rationale: { type: "string" as const, description: "Why it matters." },
        context: {
          type: "string" as const,
          description:
            "Briefing for a future session with none of this one's context: objective, scope boundaries, relevant files/tests, acceptance criteria, decisions made -- what the repo alone won't reveal.",
        },
        priority: {
          type: "string" as const,
          enum: ["must", "should", "could", "wont"],
          description: "MoSCoW, default could.",
        },
        value: { type: "string" as const, enum: ["low", "medium", "high"], description: "Default medium." },
        effort: { type: "string" as const, enum: ["low", "medium", "high"], description: "Default medium." },
        status: {
          type: "string" as const,
          enum: ["idea", "planned", "in_progress", "done"],
          description: "Default idea.",
        },
        triage: {
          type: "string" as const,
          enum: ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"],
          description:
            "Who the card waits on. ready-for-agent = specified enough to take as written. wontfix requires priority=wont.",
        },
        tags: { type: "array" as const, items: { type: "string" as const } },
        depends_on: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Ids of items this one depends on.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "roadmap_update",
    description:
      "Partially update a roadmap item (only fields you pass change): reprioritize, retag, rewrite, or move status. status=archived archives, any other status restores. status:in_progress locks it; a status write on an item locked by another peer is refused (409). Claiming an [INACTIVE] card is refused (403).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
        title: { type: "string" as const },
        kind: { type: "string" as const, enum: ["feature", "bug", "debt", "idea", "chore", "directive"] },
        directive: {
          type: "string" as const,
          enum: ["clear", "compact", "magic_compact"],
          description: "kind='directive' only.",
        },
        target_peer_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "kind='directive' only.",
        },
        description: { type: "string" as const },
        rationale: { type: "string" as const },
        context: {
          type: "string" as const,
          description: "Briefing for a future agent (see roadmap_add). Replaces the whole field.",
        },
        priority: { type: "string" as const, enum: ["must", "should", "could", "wont"] },
        value: { type: "string" as const, enum: ["low", "medium", "high"] },
        effort: { type: "string" as const, enum: ["low", "medium", "high"] },
        status: {
          type: "string" as const,
          enum: ["idea", "planned", "in_progress", "done", "archived"],
        },
        triage: {
          type: "string" as const,
          enum: ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"],
          description: "Triage role. wontfix requires priority=wont.",
        },
        tags: { type: "array" as const, items: { type: "string" as const } },
        depends_on: { type: "array" as const, items: { type: "string" as const } },
        locked: {
          type: "boolean" as const,
          description: "Usually implicit. false releases your lock while staying in_progress, true re-claims.",
        },
        release: {
          type: "boolean" as const,
          description:
            "Release or reclaim a card locked by another peer in your OWN group (refused across groups). Distinct from force, which overrides the true owner.",
        },
        // queue sets only this card's own rank; it never reorders or renumbers
        // the rest of the queue. Global reorder is /roadmap/reorder,
        // deliberately not exposed here.
        queue: { type: "number" as const, description: "Rank; null dequeues; ties share a wave." },
      },
      required: ["id"],
    },
  },
  {
    name: "roadmap_archive",
    description:
      "Archive a roadmap item (reversible soft delete: it disappears from default lists but can be restored with roadmap_update status).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
      },
      required: ["id"],
    },
  },
  {
    name: "roadmap_append_context",
    description:
      "Append a note to a roadmap item's context without replacing it (roadmap_update replaces). Use it to leave a note on another agent's card: the work-lock does not block it. Not idempotent; a retry may land twice. The operator's next Save may overwrite appended text: durable facts go in description/rationale. Does not refresh updated_at.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" as const, description: "Item id, or a unique id prefix." },
        text: { type: "string" as const, description: "The note." },
        supersedes: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Existing context targets this append replaces.",
        },
      },
      required: ["id", "text"],
    },
  },
] as const;
