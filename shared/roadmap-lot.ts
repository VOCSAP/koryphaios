// Membership is independent of the queue rank: a dispatched card leaves the queue and stays in its lot.

import type { RoadmapItem } from "./types.ts";

/**
 * Lot of the queue that carries no name. A real id and never null, because
 * ordering is keyed by (project_key, lot_id).
 */
export const DEFAULT_ROADMAP_LOT_ID = "default";

export const ROADMAP_LOT_COLOR_COUNT = 8;

export interface RoadmapLot {
  /** Unique within its project; two lots may share a name. */
  id: string;
  project_key: string;
  name: string;
  /** Attribution only: composing a lot reserves nothing. */
  created_by: string;
  /** ISO 8601 UTC. */
  created_at: string;
  /** ISO 8601 UTC; null while the lot is open. */
  closed_at: string | null;
  /** Palette slot, 0-based; null once the lot is closed. */
  color: number | null;
}

export interface RoadmapLotCard {
  id: string;
  /** null: the card belongs to no lot. A queued card always names one. */
  lot_id: string | null;
  /** Positive integer counted from 1; null: not in the queue. */
  queue: number | null;
}

/** `from` and `to` are lot ids; null stands for "in no lot". */
export interface RoadmapLotMove {
  ids: readonly string[];
  from: string | null;
  to: string | null;
}

export interface RoadmapLotAuthorFields {
  by: string;
  instance_token?: string;
}

export interface RoadmapLotCreateRequest extends RoadmapLotAuthorFields {
  project_key: string;
  name: string;
}

export interface RoadmapLotCreateResponse {
  lot: RoadmapLot;
}

export interface RoadmapLotListRequest {
  project_key: string;
}

export interface RoadmapLotListResponse {
  lots: RoadmapLot[];
}

export interface RoadmapLotMoveRequest extends RoadmapLotAuthorFields, RoadmapLotMove {
  project_key: string;
}

export interface RoadmapLotMoveResponse {
  items: RoadmapItem[];
}

export type RoadmapLotMoveResult<C extends RoadmapLotCard> =
  | { ok: true; cards: C[] }
  | { ok: false; code: "same_lot" }
  | { ok: false; code: "unknown_card" | "lot_mismatch"; card_id: string };

export function isNamedRoadmapLot(lotId: string | null | undefined): boolean {
  return typeof lotId === "string" && lotId !== DEFAULT_ROADMAP_LOT_ID;
}

export function lotForRank(lotId: string | null | undefined, rank: number | null): string | null {
  return lotId ?? (rank === null ? null : DEFAULT_ROADMAP_LOT_ID);
}

export function lotMembers<C extends RoadmapLotCard>(cards: readonly C[], lotId: string): C[] {
  return cards.filter((card) => card.lot_id === lotId);
}

/**
 * The only way a card changes lot, all or nothing over one project's cards.
 * Naming the source is what keeps membership exclusive: a card held elsewhere
 * is refused. A moved card drops its rank, which only means something inside
 * the lot it leaves.
 */
export function moveLotMembers<C extends RoadmapLotCard>(
  cards: readonly C[],
  move: RoadmapLotMove,
): RoadmapLotMoveResult<C> {
  if (move.from === move.to) return { ok: false, code: "same_lot" };
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const id of move.ids) {
    const card = byId.get(id);
    if (card === undefined) return { ok: false, code: "unknown_card", card_id: id };
    if (card.lot_id !== move.from) return { ok: false, code: "lot_mismatch", card_id: id };
  }
  const moved = new Set(move.ids);
  return {
    ok: true,
    cards: cards.map((card) => (moved.has(card.id) ? { ...card, lot_id: move.to, queue: null } : card)),
  };
}

/** Throws on a stored colour outside the palette: it would silently skew every later allocation. */
export function allocateLotColor(lots: readonly Pick<RoadmapLot, "color">[]): number {
  const uses = new Array<number>(ROADMAP_LOT_COLOR_COUNT).fill(0);
  for (const { color } of lots) {
    if (color === null) continue;
    if (!Number.isInteger(color) || color < 0 || color >= ROADMAP_LOT_COLOR_COUNT) {
      throw new RangeError(`roadmap lot colour out of range: ${color}`);
    }
    uses[color]! += 1;
  }
  return uses.indexOf(Math.min(...uses));
}
