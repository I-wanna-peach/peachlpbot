import type { Address, Hex } from "viem";
import type { Dex } from "../chains.js";

export type PositionChangeKind =
  | "OPENED"
  | "INCREASED"
  | "DECREASED"
  | "CLOSED"
  | "TRANSFERRED_IN"
  | "TRANSFERRED_OUT"
  | "COLLECTED";

export interface PendingPositionChange {
  dex: Dex;
  tokenId: bigint;
  owner: Address;
  kind: PositionChangeKind;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  poolRef: string | null;
  tickLower: number | null;
  tickUpper: number | null;
  liquidityDelta: bigint | null;
  amount0: bigint | null;
  amount1: bigint | null;
}

/**
 * One operation can emit several logs (a v4 mint is a Transfer plus a
 * ModifyLiquidity; a v3 burn is a DecreaseLiquidity plus a Transfer to zero).
 * Keep one notification per (token, owner, transaction), with the most
 * meaningful kind winning.
 */
const PRIORITY: Record<PositionChangeKind, number> = {
  CLOSED: 7,
  OPENED: 6,
  TRANSFERRED_OUT: 5,
  TRANSFERRED_IN: 5,
  DECREASED: 4,
  INCREASED: 3,
  COLLECTED: 2,
};

export function positionChangeKey(
  change: Pick<PendingPositionChange, "dex" | "tokenId" | "owner" | "transactionHash">,
): string {
  return `${change.dex}:${change.tokenId.toString()}:${change.owner.toLowerCase()}:${change.transactionHash.toLowerCase()}`;
}

/** Merges a decoded change into the per-transaction map, keeping the primary kind. */
export function mergePositionChange(
  changes: Map<string, PendingPositionChange>,
  change: PendingPositionChange,
): void {
  const key = positionChangeKey(change);
  const existing = changes.get(key);
  if (existing === undefined) {
    changes.set(key, change);
    return;
  }

  const winner = PRIORITY[change.kind] >= PRIORITY[existing.kind] ? change : existing;
  const loser = winner === change ? existing : change;
  changes.set(key, {
    ...winner,
    poolRef: winner.poolRef ?? loser.poolRef,
    tickLower: winner.tickLower ?? loser.tickLower,
    tickUpper: winner.tickUpper ?? loser.tickUpper,
    liquidityDelta: winner.liquidityDelta ?? loser.liquidityDelta,
    amount0: winner.amount0 ?? loser.amount0,
    amount1: winner.amount1 ?? loser.amount1,
    logIndex: Math.min(winner.logIndex, loser.logIndex),
  });
}
