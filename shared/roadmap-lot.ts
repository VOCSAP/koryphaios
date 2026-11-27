// Membership is independent of the queue rank: a dispatched card leaves the queue and stays in its lot.

import type { AtomicDispatchIntent, RoadmapItem } from "./types.ts";

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

/** The controller of a lot's execution mandates one session of its own Kory run. */
export interface RoadmapLotGrantRequest extends RoadmapLotAuthorFields {
  project_key: string;
  lot_id: string;
  to_peer_id: string;
}

export interface RoadmapLotGrantResponse {
  lot_id: string;
  epoch: number;
  peer_id: string;
}

/** The execution routes take an operator-signed body; `lot_id` may name the default queue where noted. */
export interface RoadmapLotExecutionStateRequest extends RoadmapLotAuthorFields {
  project_key: string;
  /** The default queue is accepted: it has sends and no execution. */
  lot_id: string;
}

/** What an operator reads of an execution: no run, no instance digest. */
export interface RoadmapLotExecutionView {
  epoch: number;
  state: "running" | "interrupted";
  group_id: string;
  controller_peer_id: string;
  started_at: string;
  interrupted_at: string | null;
  interrupted_reason: string | null;
  /** The signing operator holds it. */
  own: boolean;
}

/** One send still waited on: its card is neither closed, sent again nor set aside. */
export interface RoadmapLotOpenSend {
  card_id: string;
  /** 0 on the default queue. */
  epoch: number;
  mode: AtomicDispatchIntent["mode"];
  target_peer_id: string;
  sent_at: string;
  claimed_at: string | null;
  /** The signing operator sent it. */
  own: boolean;
}

export interface RoadmapLotQueuedCard {
  card_id: string;
  queue: number;
  content_rev: number;
  dispatch_state_tag: string;
}

export interface RoadmapLotExecutionStateResponse {
  lot_id: string;
  /** What a start signs: the lot's last closed epoch, 0 when none. */
  closed_epoch: number;
  execution: RoadmapLotExecutionView | null;
  open_sends: RoadmapLotOpenSend[];
  queue: RoadmapLotQueuedCard[];
}

export interface RoadmapLotResumeRequest extends RoadmapLotAuthorFields {
  project_key: string;
  lot_id: string;
  /** The interrupted epoch the operator read. */
  expected_epoch: number;
  /** The session of the signing run that takes the lot over. */
  to_peer_id: string;
  group_id: string;
  group_secret_hash: string | null;
  run_ref: string;
}

export interface RoadmapLotResumeResponse {
  lot_id: string;
  epoch: number;
}

export interface RoadmapLotCloseRequest extends RoadmapLotAuthorFields {
  project_key: string;
  lot_id: string;
  expected_epoch: number;
  /** Closes although sends are still open, and settles them. */
  confirm_open_sends?: boolean;
}

export interface RoadmapLotCloseResponse {
  lot_id: string;
  epoch: number;
  /** Cards whose send was still open. */
  settled: string[];
}

export interface RoadmapLotRemoveSendRequest extends RoadmapLotAuthorFields {
  project_key: string;
  /** The default queue is accepted: the operator sets aside a send of its own. */
  lot_id: string;
  /** 0 on the default queue. */
  expected_epoch: number;
  card_id: string;
}

export interface RoadmapLotRemoveSendResponse {
  lot_id: string;
  card_id: string;
  settled: number;
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
