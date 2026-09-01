// Card 4dcd4f04: roadmap_add/roadmap_update over MCP stdio must return a
// compact ack, never the full item (nobody consumes that echo, and it can
// carry kilobytes of `context`/`description`). Harness mirrors
// server-ask-operator.test.ts (spawn `bun server.ts`, speak JSON-RPC on stdin).
//
// Reviewer FAIL on the first cut of this card: the ack was built from the
// caller's RAW ARGS, so it lied on 5 fields the broker silently changes --
// title (trim), tags/depends_on (cleanList drops), target_peer_ids
// (cleanPeerIds / reset to [] outside kind='directive'), and locked
// (roadmap_add never forwards it at all). This file replays that exact
// probe as a versioned test (a probe that proves once in /tmp and then
// disappears never existed), and adds a schema-drift guard so a 15th field
// added to RoadmapUpsertRequest tomorrow fails this suite the same day.

import { test, expect, describe, afterAll } from "bun:test";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import {
  ROADMAP_ADD_ACK_FIELDS,
  ROADMAP_UPDATE_ACK_FIELDS,
  findUncoveredAckFields,
} from "../shared/types.ts";

/**
 * Every tool name starting with "roadmap_" that server.ts registers, mapped
 * to its ack FIELD domain (checked via findUncoveredAckFields) or `null`
 * when its ack is not RoadmapItem-field-pick-list shaped at all (roadmap_get/
 * list/archive: no per-field ack; roadmap_append_context: reports a byte
 * count, not a list of RoadmapItem fields; roadmap_dispatch: reports which
 * CARDS were dispatched and which TILES they hit, so its ack names no
 * RoadmapItem field at all). See the test below for how a 4th tool, or a
 * stale entry, fails this the same day it happens.
 *
 * `null` is this table's EXEMPTION form, not a hole: the test below skips the
 * field comparison for a null domain, so an entry landing here must be
 * justified by the SHAPE of its ack, never by the absence of one being
 * convenient.
 */
const ROADMAP_TOOL_ACK_DOMAINS: Record<string, readonly string[] | null> = {
  roadmap_list: null,
  roadmap_get: null,
  roadmap_add: ROADMAP_ADD_ACK_FIELDS,
  roadmap_update: ROADMAP_UPDATE_ACK_FIELDS,
  roadmap_archive: null,
  roadmap_append_context: null,
  // Card bf76d37f. Mutates NO card: it runs the head wave of the queue, so it
  // acknowledges an EXECUTION, not a set of written fields. Two reasons a
  // field domain would be wrong rather than merely unnecessary here. Its
  // inputSchema has zero properties (the no-argument ruling), so any non-null
  // domain would make findUncoveredAckFields compare an empty list and pass
  // VACUOUSLY -- green while asserting nothing. And its ack deliberately
  // cannot be a card-field echo: runDirectiveWave marks a card done BEFORE
  // executing it, which is why this tool reports tiles hit / missed /
  // ambiguous instead of anything read back off the RoadmapItem.
  roadmap_dispatch: null,
};

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const b of brokers) await stopBroker(b);
});

interface JsonRpcResponse {
  id?: number;
  result?: {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let idx: number;
    while ((idx = buffer.text.indexOf("\n")) >= 0) {
      const line = buffer.text.slice(0, idx).trim();
      buffer.text = buffer.text.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id === wantedId) return msg;
      } catch {
        /* not a complete JSON line yet */
      }
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer.text += decoder.decode(value, { stream: true });
  }
  throw new Error(`no JSON-RPC response with id ${wantedId}`);
}

interface Harness {
  b: TestBroker;
  proc: ReturnType<typeof Bun.spawn>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  send: (msg: unknown) => void;
}

let nextRpcId = 1;

// Card 4441e883, Trou B: `bootOnBroker` factors the process-spawn half of
// `boot()` out so a SECOND server.ts instance can be pointed at an EXISTING
// broker instead of minting its own -- broker.ts's /register session_key
// collision branch (broker.ts:1687-1716) mints a fresh peer_id/instance_token
// for a second process sharing the same host+cwd+tty against an already-
// active session, so two harnesses booted this way onto the SAME broker are
// two genuinely distinct, independently PROVEN identities (own instance_token
// each), never the same peer reconnecting. That distinctness is exactly what
// B1/B2 need: one session claims a card's work-lock, the other must NOT be
// mistaken for it.
async function bootOnBroker(b: TestBroker, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    ...extraEnv,
  };
  delete env.CLAUDE_PEERS_APPROVAL_FILE;

  const proc = Bun.spawn(["bun", "server.ts"], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };

  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "test-harness", version: "0.0.1" },
    },
  });
  await readUntil(reader, 0, buffer);

  return { b, proc, reader, buffer, send };
}

async function boot(): Promise<Harness> {
  const b = await startBroker();
  brokers.push(b);
  return bootOnBroker(b);
}

async function callTool(
  h: Harness,
  name: string,
  args: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return readUntil(h.reader, id, h.buffer);
}

function ackText(res: JsonRpcResponse): string {
  return res.result?.content?.[0]?.text ?? "";
}

/**
 * Extracts ONLY the "  set: ..." / "  changed: ..." line -- the fields the
 * caller actually requested and the broker actually forwarded. Coverage
 * assertions must run against this line, never the whole ack text: a field
 * silently downgraded to the neighboring "defaults:"/"unchanged:" line would
 * still leave its NAME sitting somewhere in the full text, passing a
 * name-presence check that proves nothing about forwarding.
 */
function passedFieldsLine(text: string): string {
  const m = text.match(/^ {2}(?:set|changed): (.*)$/m);
  return m ? m[1]! : "";
}

describe("roadmap_add/roadmap_update MCP ack", () => {
  test("roadmap_update on a >1000 char context reports landed size, never the content", async () => {
    const h = await boot();
    const bigContext = "x".repeat(3512);

    const created = await callTool(h, "roadmap_add", {
      title: "compact ack test card",
      kind: "debt",
    });
    expect(created.result?.isError).toBeFalsy();
    const createdText = ackText(created);
    const idMatch = createdText.match(/Roadmap item created: ([0-9a-f]{8})/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const updated = await callTool(h, "roadmap_update", { id, context: bigContext, status: "planned" });
    expect(updated.result?.isError).toBeFalsy();
    const updatedText = ackText(updated);

    // The proof that matters: the 3512-char payload never appears in the ack.
    expect(updatedText).not.toContain(bigContext);
    expect(updatedText.length).toBeLessThan(500);

    // The ack still names what changed, compactly, and now from the LANDED
    // value (context is never touched broker-side, so requested == landed).
    expect(updatedText).toContain("context: requested 3512 chars, landed 3512 chars");
    expect(updatedText).toContain("status -> planned");
    expect(updatedText).toContain("updated:");
  }, 60_000);

  test("roadmap_add lists passed fields and defaults, never a bare full-item dump", async () => {
    const h = await boot();
    const description = "d".repeat(1200);

    const created = await callTool(h, "roadmap_add", {
      title: "second ack test card",
      kind: "feature",
      description,
    });
    expect(created.result?.isError).toBeFalsy();
    const text = ackText(created);

    expect(text).not.toContain(description);
    expect(text).toContain("description: requested 1200 chars, landed 1200 chars");
    expect(text).toContain("kind -> feature");
    expect(text).toContain("Roadmap item created:");
  }, 60_000);

  test("reviewer's probe replayed: ack landed values match roadmap_get's real item, not the caller's raw args", async () => {
    const h = await boot();
    const rawTitle = "  padded probe title  ";

    const created = await callTool(h, "roadmap_add", {
      title: rawTitle,
      kind: "feature", // non-directive: target_peer_ids must be discarded broker-side
      tags: ["a", "", "  ", "b"], // reviewer's exact probe: 4 raw entries, 2 survive cleanList
      depends_on: ["b", "   ", "c"], // same cleanList code path: 3 raw, 2 survive
      target_peer_ids: ["probe-peer-a", "probe-peer-b"], // must land as 0, kind isn't 'directive'
      locked: true, // not in roadmap_add's domain/schema -- must never appear in the ack
    });
    expect(created.result?.isError).toBeFalsy();
    const ack = ackText(created);
    const idMatch = ack.match(/Roadmap item created: ([0-9a-f]{8})/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    // `locked` is outside roadmap_add's ack domain (arbitrage: it is never
    // forwarded to the broker on create) -- it must not appear at all, not
    // even as `locked -> false`.
    expect(ack).not.toContain("locked");

    // Cross-check against the OTHER real source of truth: roadmap_get, which
    // reads straight off the broker's stored row (not off this call's args).
    const fetched = await callTool(h, "roadmap_get", { id });
    expect(fetched.result?.isError).toBeFalsy();
    const detail = ackText(fetched);
    const itemLine = detail.split("\n")[0] ?? "";

    // Title: broker trims. The landed title in roadmap_get's line must be the
    // TRIMMED string, and the ack's own landed-chars count must match its length.
    const landedTitle = (itemLine.split("— ")[1] ?? "").split("  #")[0] ?? "";
    expect(landedTitle).toBe(rawTitle.trim());
    const titleAckMatch = ack.match(/title: requested (\d+) chars, landed (\d+) chars/);
    expect(titleAckMatch).not.toBeNull();
    expect(Number(titleAckMatch![1])).toBe(rawTitle.length);
    expect(Number(titleAckMatch![2])).toBe(landedTitle.length);
    expect(landedTitle.length).not.toBe(rawTitle.length); // the bug only bites if these differ

    // Tags: roadmap_get's item line renders them as `#tag #tag`.
    const landedTagCount = (itemLine.match(/#[^\s#]+/g) ?? []).length;
    const tagsAckMatch = ack.match(/tags -> (\d+) item\(s\)/);
    expect(tagsAckMatch).not.toBeNull();
    expect(Number(tagsAckMatch![1])).toBe(landedTagCount);
    expect(landedTagCount).toBe(2); // "a" and "b" survive; "" and "  " do not
    expect(landedTagCount).not.toBe(4); // the bug: caller sent 4 raw entries

    // depends_on: only rendered by roadmap_get when non-empty, as a comma list.
    const dependsOnLine = detail.split("\n").find((l) => l.trim().startsWith("depends_on:"));
    const landedDependsOnCount = dependsOnLine
      ? dependsOnLine.split(":")[1]!.split(",").map((s) => s.trim()).filter(Boolean).length
      : 0;
    const dependsOnAckMatch = ack.match(/depends_on -> (\d+) item\(s\)/);
    expect(dependsOnAckMatch).not.toBeNull();
    expect(Number(dependsOnAckMatch![1])).toBe(landedDependsOnCount);
    expect(landedDependsOnCount).toBe(2); // "b" and "c" survive; "   " does not

    // target_peer_ids: non-directive kind -> broker discards them entirely.
    // Real proof of absence: neither probe id appears anywhere in roadmap_get's text.
    expect(detail).not.toContain("probe-peer-a");
    expect(detail).not.toContain("probe-peer-b");
    const targetsAckMatch = ack.match(/target_peer_ids -> (\d+) item\(s\)/);
    expect(targetsAckMatch).not.toBeNull();
    expect(Number(targetsAckMatch![1])).toBe(0);
  }, 60_000);

  test("roadmap_add's ack names all 13 fields in its domain, each with its own distinct value", async () => {
    const h = await boot();
    // Every same-category field gets a DISTINCT value/length/cardinality:
    // swapping any two extractors in ROADMAP_UPSERT_ACK_FIELDS (shared/types.ts)
    // must flip at least one of the hardcoded assertions below, not just leave
    // a field NAME sitting somewhere in the ack text (reviewer-caught trap:
    // same-length long fields / same-cardinality lists / name-only short checks).
    const title = "full coverage create probe";
    const created = await callTool(h, "roadmap_add", {
      title,
      description: "d".repeat(50),
      rationale: "r".repeat(51),
      context: "c".repeat(52),
      kind: "directive", // required for target_peer_ids to land at a nonzero count
      priority: "should",
      value: "high",
      effort: "low",
      status: "planned",
      directive: "clear",
      tags: ["t1"], // 1 item
      depends_on: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"], // 2
      target_peer_ids: ["probe-full-a", "probe-full-b", "probe-full-c"], // 3
    });
    expect(created.result?.isError).toBeFalsy();
    const text = ackText(created);
    const line = passedFieldsLine(text);
    expect(line).not.toBe("");

    // Self-updating coverage: every field in the domain must be named on the
    // "set:" line specifically (not merely somewhere in the whole ack, which
    // would also match a field that silently fell to the "defaults:" line).
    expect(ROADMAP_ADD_ACK_FIELDS.length).toBe(13);
    for (const field of ROADMAP_ADD_ACK_FIELDS) {
      expect(line).toContain(field);
    }

    // Hardcoded, distinct-per-field value checks: this is what actually
    // catches an extractor swap between two fields of the same category.
    expect(line).toContain(`title: requested ${title.length} chars, landed ${title.length} chars`);
    expect(line).toContain("description: requested 50 chars, landed 50 chars");
    expect(line).toContain("rationale: requested 51 chars, landed 51 chars");
    expect(line).toContain("context: requested 52 chars, landed 52 chars");
    expect(line).toContain("kind -> directive");
    expect(line).toContain("priority -> should");
    expect(line).toContain("value -> high");
    expect(line).toContain("effort -> low");
    expect(line).toContain("status -> planned");
    expect(line).toContain("directive -> clear");
    expect(line).toContain("tags -> 1 item(s)");
    expect(line).toContain("depends_on -> 2 item(s)");
    expect(line).toContain("target_peer_ids -> 3 item(s)");
  }, 60_000);

  test("roadmap_update's ack names all 15 fields in its domain, each with its own distinct value", async () => {
    const h = await boot();
    const created = await callTool(h, "roadmap_add", { title: "base card for update coverage" });
    const id = ackText(created).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;

    const title = "full coverage update probe";
    const updated = await callTool(h, "roadmap_update", {
      id,
      title,
      description: "d".repeat(60),
      rationale: "r".repeat(61),
      context: "c".repeat(62),
      kind: "directive",
      priority: "must",
      value: "low",
      effort: "high",
      status: "in_progress", // required for `locked: true` to actually take
      directive: "compact",
      tags: ["t2"], // 1 item
      depends_on: ["33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"], // 2
      target_peer_ids: ["probe-upd-a", "probe-upd-b", "probe-upd-c"], // 3
      locked: true,
      queue: 5,
    });
    expect(updated.result?.isError).toBeFalsy();
    const text = ackText(updated);
    const line = passedFieldsLine(text);
    expect(line).not.toBe("");

    expect(ROADMAP_UPDATE_ACK_FIELDS.length).toBe(15);
    for (const field of ROADMAP_UPDATE_ACK_FIELDS) {
      expect(line).toContain(field);
    }

    expect(line).toContain(`title: requested ${title.length} chars, landed ${title.length} chars`);
    expect(line).toContain("description: requested 60 chars, landed 60 chars");
    expect(line).toContain("rationale: requested 61 chars, landed 61 chars");
    expect(line).toContain("context: requested 62 chars, landed 62 chars");
    expect(line).toContain("kind -> directive");
    expect(line).toContain("priority -> must");
    expect(line).toContain("value -> low");
    expect(line).toContain("effort -> high");
    expect(line).toContain("status -> in_progress");
    expect(line).toContain("directive -> compact");
    expect(line).toContain("locked -> true");
    expect(line).toContain("queue -> 5");
    expect(line).toContain("tags -> 1 item(s)");
    expect(line).toContain("depends_on -> 2 item(s)");
    expect(line).toContain("target_peer_ids -> 3 item(s)");
  }, 60_000);

  test("every roadmap_ tool in the live tools/list is accounted for in ROADMAP_TOOL_ACK_DOMAINS, and field-pick-list tools stay covered", async () => {
    // Review delta, card 562fd9b5: this used to be two hand-written find()
    // calls for roadmap_add/roadmap_update only. A third tool
    // (roadmap_append_context) shipped with zero test coverage and this
    // guard did not notice, because its domain wasn't unioned/checked, it
    // was simply never asked about. A TABLE plus a membership assertion in
    // BOTH directions closes that: a 4th roadmap_ tool added tomorrow
    // without a matching entry here fails this test the same day, and a
    // stale entry for a tool that got removed fails it too.
    const h = await boot();
    h.send({ jsonrpc: "2.0", id: nextRpcId, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, nextRpcId, h.buffer);
    nextRpcId++;
    const tools = res.result?.tools ?? [];
    const roadmapTools = tools.filter((t) => t.name.startsWith("roadmap_"));
    expect(roadmapTools.length).toBeGreaterThan(0); // the probe must SEE tools before its silence means anything

    const roadmapToolNames = roadmapTools.map((t) => t.name);
    for (const name of roadmapToolNames) {
      expect(Object.keys(ROADMAP_TOOL_ACK_DOMAINS)).toContain(name);
    }
    for (const name of Object.keys(ROADMAP_TOOL_ACK_DOMAINS)) {
      expect(roadmapToolNames).toContain(name); // catches a stale entry for a removed tool
    }

    for (const [name, domain] of Object.entries(ROADMAP_TOOL_ACK_DOMAINS)) {
      if (domain === null) continue; // not a field-pick-list-shaped ack (roadmap_append_context reports a byte count, not RoadmapItem fields; roadmap_dispatch reports dispatched cards and the tiles they hit; roadmap_get/list/archive have no per-field ack at all)
      const tool = roadmapTools.find((t) => t.name === name)!;
      const schemaFields = Object.keys(tool.inputSchema?.properties ?? {}).filter((f) => f !== "id");
      const diff = findUncoveredAckFields(schemaFields, domain);
      expect(diff.missing).toEqual([]);
      expect(diff.extra).toEqual([]);
    }

    // The asymmetry a unioned comparison would hide: `locked` is real on
    // roadmap_update's schema/domain but absent from roadmap_add's.
    const addSchemaFields = Object.keys(
      roadmapTools.find((t) => t.name === "roadmap_add")!.inputSchema?.properties ?? {}
    );
    const updateSchemaFields = Object.keys(
      roadmapTools.find((t) => t.name === "roadmap_update")!.inputSchema?.properties ?? {}
    );
    expect(addSchemaFields).not.toContain("locked");
    expect(updateSchemaFields).toContain("locked");
  }, 60_000);

  test("roadmap_append_context's ack never contains the appended content, end to end over MCP stdio", async () => {
    const h = await boot();
    const created = await callTool(h, "roadmap_add", { title: "append ack target" });
    expect(created.result?.isError).toBeFalsy();
    const id = ackText(created).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;

    const secretNote = "s".repeat(2000);
    const appended = await callTool(h, "roadmap_append_context", { id, text: secretNote });
    expect(appended.result?.isError).toBeFalsy();
    const ack = ackText(appended);

    expect(ack).not.toContain(secretNote);
    expect(ack.length).toBeLessThan(500);
    expect(ack).toContain("Roadmap item context appended:");
    // "appended N chars (header included)" -- N must be strictly more than
    // the 2000-char note, proving the header is really counted in, not just
    // claimed to be.
    const match = ack.match(/appended (\d+) chars \(header included\), context now (\d+) chars/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(secretNote.length);
    expect(Number(match![2])).toBeGreaterThan(secretNote.length);
  }, 60_000);

  // Card 4441e883, Trou B (team-lead review): formatRoadmapUpsertAck's
  // work-lock trailer (server.ts) had zero coverage anywhere -- these two are
  // the pair, B1 the positive case and B2 the negative control that carries
  // the real weight (the card explicitly forbids a generic nudge toward
  // callers holding NO lock -- server.ts:1111-1114 -- so a regression that
  // widens the trailer to every caller must be caught here). Anchored on the
  // stable fragment "you hold this card's work-lock" rather than the full
  // line: a parallel developer session is actively reformatting `locked_at`
  // and the follow-up advice clause in the SAME line (team-lead brief), so
  // asserting the whole string would break on an unrelated, correct edit.
  const WORK_LOCK_TRAILER_FRAGMENT = "you hold this card's work-lock";

  test("card 4441e883 (Trou B1): a proven holder's own write on its locked card carries the work-lock trailer", async () => {
    const h = await boot();
    // roadmap_add doesn't forward `locked`, but a non-'deck' author writing
    // status=in_progress on a fresh item claims it implicitly (PLAN K2) --
    // same implicit-claim path A1/A2 exercise at the HTTP layer, here
    // reached through the MCP tool this session's own identity actually
    // uses. This session's `myInstanceToken` is what the broker just proved.
    const created = await callTool(h, "roadmap_add", {
      title: "B1: created already claimed by its own author",
      status: "in_progress",
    });
    expect(created.result?.isError).toBeFalsy();
    const ack = ackText(created);
    expect(ack).toContain(WORK_LOCK_TRAILER_FRAGMENT);
  }, 60_000);

  test("card 4441e883 (Trou B2, negative control): a NON-holder's write on someone else's locked card carries NO work-lock trailer at all", async () => {
    const holder = await boot();
    const created = await callTool(holder, "roadmap_add", {
      title: "B2: locked by the holder session, then edited by a stranger",
      status: "in_progress",
    });
    expect(created.result?.isError).toBeFalsy();
    const id = ackText(created).match(/Roadmap item created: ([0-9a-f]{8})/)![1]!;

    // A genuinely different, independently proven session against the SAME
    // broker (bootOnBroker's whole reason to exist -- see its doc comment).
    const stranger = await bootOnBroker(holder.b);
    // Neither `status` nor `locked`: an ORDINARY write, same shape the
    // broker-level 409 guard already lets through untouched (see
    // tests/broker-roadmap-lock.test.ts, "Non-status writes stay open").
    const edited = await callTool(stranger, "roadmap_update", {
      id,
      context: "an unrelated edit from a stranger while the card stays locked",
    });
    expect(edited.result?.isError).toBeFalsy();
    const ack = ackText(edited);
    expect(ack).not.toContain(WORK_LOCK_TRAILER_FRAGMENT);
    expect(ack).not.toContain("work-lock");
  }, 60_000);
});

describe("findUncoveredAckFields (pure, synthetic)", () => {
  test("catches both a stale domain entry and a missing schema field", () => {
    const { missing, extra } = findUncoveredAckFields(["a", "b", "c"], ["a", "b", "z"]);
    expect(missing).toEqual(["c"]); // schema has "c", domain forgot it
    expect(extra).toEqual(["z"]); // domain has "z", schema no longer does
  });

  test("reports no drift when the two sets match exactly", () => {
    const { missing, extra } = findUncoveredAckFields(["a", "b"], ["b", "a"]);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });
});
