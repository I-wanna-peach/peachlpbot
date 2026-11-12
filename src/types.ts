import type { Address, Hex } from "viem";
import type { Dex } from "./chains.js";

/** Cached ERC-20 display metadata; decimals is required before pricing. */
export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface ChainBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

export interface ChainLog {
  address: Address;
  blockHash: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  data: Hex;
  topics: readonly Hex[];
}

export type RangeState = "UNKNOWN" | "IN_RANGE" | "OUT_OF_RANGE";
export type PositionStatus = "ACTIVE" | "CLOSED";

/** A row in `positions`: the per-chain LP position index, keyed by (chainId, dex, tokenId). */
export interface PositionRecord {
  chainId: bigint;
  dex: Dex;
  tokenId: bigint;
  owner: Address;
  poolRef: string;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  status: PositionStatus;
  rangeState: RangeState;
  outStreak: number;
  inStreak: number;
  stateVersion: number;
  lastEvalBlock: bigint | null;
  openedBlock: bigint;
  updatedBlock: bigint;
  updatedBlockHash: Hex;
}

export interface PoolRecord {
  chainId: bigint;
  dex: Dex;
  poolRef: string;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  currentTick: number | null;
  sqrtPriceX96: bigint | null;
  liquidity: bigint | null;
  initialized: boolean;
}

export type IncidentType = "LP_OUT_OF_RANGE" | "LP_BACK_IN_RANGE" | "LP_POSITION_CHANGED";

export interface IncidentRecord {
  chainId: bigint;
  idempotencyKey: string;
  type: IncidentType;
  dex: Dex;
  poolRef: string;
  tokenId: bigint | null;
  owner: Address | null;
  fromState: RangeState | null;
  toState: RangeState | null;
  stateVersion: number;
  blockNumber: bigint;
  blockHash: Hex;
  payload: Record<string, unknown>;
}

export type DeliveryStatus = "QUEUED" | "SENDING" | "DELIVERED" | "RETRY_WAIT" | "FAILED_FINAL";

export interface SubscriptionRecord {
  id: string;
  telegramChatId: string;
  watchedAddress: Address;
  nickname: string | null;
  status: "ACTIVE" | "REVOKED";
}

/**
 * The decoded event union. Deliberately small: it carries exactly what the
 * indexer writes, so there is one decode path per source contract.
 */
export type DecodedEvent =
  | { type: "v4_initialize"; blockNumber: bigint; logIndex: number; poolId: Hex; currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
  | { type: "v4_transfer"; blockNumber: bigint; logIndex: number; from: Address; to: Address; tokenId: bigint }
  | { type: "v4_modify_liquidity"; blockNumber: bigint; logIndex: number; poolId: Hex; tickLower: number; tickUpper: number; liquidityDelta: bigint; tokenId: bigint | null }
  | { type: "v3_transfer"; dex: Dex; blockNumber: bigint; logIndex: number; from: Address; to: Address; tokenId: bigint }
  | { type: "v3_increase"; dex: Dex; blockNumber: bigint; logIndex: number; tokenId: bigint; liquidity: bigint }
  | { type: "v3_decrease"; dex: Dex; blockNumber: bigint; logIndex: number; tokenId: bigint; liquidity: bigint }
  | { type: "v3_collect"; dex: Dex; blockNumber: bigint; logIndex: number; tokenId: bigint; amount0: bigint; amount1: bigint };
