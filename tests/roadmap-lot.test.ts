import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROADMAP_LOT_ID,
  ROADMAP_LOT_COLOR_COUNT,
  allocateLotColor,
  isNamedRoadmapLot,
  lotForRank,
  lotMembers,
  moveLotMembers,
  type RoadmapLotCard,
} from "../shared/roadmap-lot.ts";

function card(id: string, lot_id: string | null, queue: number | null = null): RoadmapLotCard {
  return { id, lot_id, queue };
}

describe("lot membership", () => {
  test("a lot cannot claim as free a card another lot holds, and nothing moves", () => {
    const cards = [card("free", null), card("held", "lot-a", 1)];
    const before = structuredClone(cards);

    const result = moveLotMembers(cards, { ids: ["free", "held"], from: null, to: "lot-b" });

    expect(result).toEqual({ ok: false, code: "lot_mismatch", card_id: "held" });
    expect(cards).toEqual(before);
  });

  test("a card that left the queue is still a member and is still not free", () => {
    const cards = [card("sent", "lot-a", null), card("queued", "lot-a", 1), card("other", "lot-b", 1)];

    expect(lotMembers(cards, "lot-a").map((c) => c.id)).toEqual(["sent", "queued"]);
    expect(moveLotMembers(cards, { ids: ["sent"], from: null, to: "lot-b" })).toEqual({
      ok: false,
      code: "lot_mismatch",
      card_id: "sent",
    });
  });

  test("a transfer naming its source changes the lot, drops the moved rank only, and keeps other fields", () => {
    const cards = [
      { ...card("moved", "lot-a", 1), title: "kept" },
      { ...card("stays", "lot-a", 2), title: "a" },
      { ...card("resident", "lot-b", 1), title: "b" },
    ];

    const result = moveLotMembers(cards, { ids: ["moved"], from: "lot-a", to: "lot-b" });

    expect(result).toEqual({
      ok: true,
      cards: [{ id: "moved", lot_id: "lot-b", queue: null, title: "kept" }, cards[1]!, cards[2]!],
    });
    expect(cards[0]!.lot_id).toBe("lot-a");
  });

  test("a move whose source is its destination is refused, so the rank survives", () => {
    const cards = [card("queued", "lot-a", 3)];

    expect(moveLotMembers(cards, { ids: ["queued"], from: "lot-a", to: "lot-a" })).toEqual({
      ok: false,
      code: "same_lot",
    });
  });

  test("an unknown card refuses the whole move", () => {
    const cards = [card("known", null)];

    expect(moveLotMembers(cards, { ids: ["known", "ghost"], from: null, to: "lot-a" })).toEqual({
      ok: false,
      code: "unknown_card",
      card_id: "ghost",
    });
  });
});

describe("lot colour", () => {
  const everySlot = Array.from({ length: ROADMAP_LOT_COLOR_COUNT }, (_, color) => ({ color }));

  test("the lowest unused slot is taken, whatever order the lots hold theirs in", () => {
    expect(allocateLotColor([{ color: 2 }, { color: 0 }])).toBe(1);
  });

  test("a lot without a colour occupies no slot", () => {
    const lots = everySlot.map((lot) => (lot.color === 3 ? { color: null } : lot));

    expect(allocateLotColor(lots)).toBe(3);
  });

  test("once every slot is taken the least used one is recycled", () => {
    expect(allocateLotColor([...everySlot, { color: 0 }])).toBe(1);
  });

  test.each([-1, ROADMAP_LOT_COLOR_COUNT, 1.5, Number.NaN])("a stored colour of %s is refused", (color) => {
    expect(() => allocateLotColor([{ color: 0 }, { color }])).toThrow(RangeError);
  });
});

describe("lot of a rank", () => {
  test("a ranked card outside every lot lands in the default one, an unranked card stays outside", () => {
    expect([lotForRank(null, 1), lotForRank(undefined, 1), lotForRank(null, null)]).toEqual([
      DEFAULT_ROADMAP_LOT_ID,
      DEFAULT_ROADMAP_LOT_ID,
      null,
    ]);
  });

  test("a card keeps the lot it has, ranked or not", () => {
    expect([lotForRank("lot-a", 2), lotForRank("lot-a", null)]).toEqual(["lot-a", "lot-a"]);
  });

  test("only a lot other than the default one is named", () => {
    expect([null, undefined, DEFAULT_ROADMAP_LOT_ID, "lot-a"].map(isNamedRoadmapLot)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});
