import { decodeEventLog, getAddress, toEventSelector, type Hex } from "viem";
import {
  erc721TransferEvent,
  v3CollectEvent,
  v3DecreaseLiquidityEvent,
  v3IncreaseLiquidityEvent,
  v4InitializeEvent,
  v4ModifyLiquidityEvent,
} from "../abi.js";
import type { ChainDescriptor } from "../chains.js";
import type { ChainLog, DecodedEvent } from "../types.js";

const TRANSFER_TOPIC = toEventSelector(erc721TransferEvent);
const INITIALIZE_TOPIC = toEventSelector(v4InitializeEvent);
const MODIFY_LIQUIDITY_TOPIC = toEventSelector(v4ModifyLiquidityEvent);
const V3_INCREASE_TOPIC = toEventSelector(v3IncreaseLiquidityEvent);
const V3_DECREASE_TOPIC = toEventSelector(v3DecreaseLiquidityEvent);
const V3_COLLECT_TOPIC = toEventSelector(v3CollectEvent);

/** The ERC-721 `Transfer` selector, exported so the indexer can build log filters. */
export const TRANSFER_SELECTOR = TRANSFER_TOPIC;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** `salt == bytes32(tokenId)`; a zero salt is a direct PoolManager call, not a position. */
export function tokenIdFromSalt(salt: Hex): bigint | null {
  const tokenId = BigInt(salt);
  return tokenId === 0n ? null : tokenId;
}

function topics(log: ChainLog): [Hex, ...Hex[]] {
  const [signature, ...rest] = log.topics;
  if (!signature) throw new Error("Log has no event signature topic.");
  return [signature, ...rest];
}

/**
 * Decodes one log from a contract we index. Returns null for a log whose address
 * or selector we do not handle, so an unrelated event in the same range is
 * skipped rather than failing the chunk.
 */
export function decodeLog(log: ChainLog, chain: ChainDescriptor): DecodedEvent | null {
  const selector = log.topics[0];
  if (!selector) return null;

  const v3Venue = chain.v3VenueByManager.get(log.address.toLowerCase());
  if (v3Venue !== undefined) {
    if (selector === TRANSFER_TOPIC) {
      const { args } = decodeEventLog({ abi: [erc721TransferEvent], data: log.data, topics: topics(log), strict: true });
      return { type: "v3_transfer", dex: v3Venue.dex, blockNumber: log.blockNumber, logIndex: log.logIndex, from: getAddress(args.from), to: getAddress(args.to), tokenId: args.tokenId };
    }
    if (selector === V3_INCREASE_TOPIC) {
      const { args } = decodeEventLog({ abi: [v3IncreaseLiquidityEvent], data: log.data, topics: topics(log), strict: true });
      return { type: "v3_increase", dex: v3Venue.dex, blockNumber: log.blockNumber, logIndex: log.logIndex, tokenId: args.tokenId, liquidity: args.liquidity };
    }
    if (selector === V3_DECREASE_TOPIC) {
      const { args } = decodeEventLog({ abi: [v3DecreaseLiquidityEvent], data: log.data, topics: topics(log), strict: true });
      return { type: "v3_decrease", dex: v3Venue.dex, blockNumber: log.blockNumber, logIndex: log.logIndex, tokenId: args.tokenId, liquidity: args.liquidity };
    }
    if (selector === V3_COLLECT_TOPIC) {
      const { args } = decodeEventLog({ abi: [v3CollectEvent], data: log.data, topics: topics(log), strict: true });
      return { type: "v3_collect", dex: v3Venue.dex, blockNumber: log.blockNumber, logIndex: log.logIndex, tokenId: args.tokenId, amount0: args.amount0, amount1: args.amount1 };
    }
  }

  const v4 = chain.v4;
  if (v4 === null) return null;

  if (sameAddress(log.address, v4.positionManager) && selector === TRANSFER_TOPIC) {
    const { args } = decodeEventLog({ abi: [erc721TransferEvent], data: log.data, topics: topics(log), strict: true });
    return { type: "v4_transfer", blockNumber: log.blockNumber, logIndex: log.logIndex, from: getAddress(args.from), to: getAddress(args.to), tokenId: args.tokenId };
  }

  if (sameAddress(log.address, v4.poolManager)) {
    if (selector === INITIALIZE_TOPIC) {
      const { args } = decodeEventLog({ abi: [v4InitializeEvent], data: log.data, topics: topics(log), strict: true });
      return {
        type: "v4_initialize", blockNumber: log.blockNumber, logIndex: log.logIndex, poolId: args.id,
        currency0: getAddress(args.currency0), currency1: getAddress(args.currency1),
        fee: Number(args.fee), tickSpacing: Number(args.tickSpacing), hooks: getAddress(args.hooks),
      };
    }
    if (selector === MODIFY_LIQUIDITY_TOPIC) {
      const { args } = decodeEventLog({ abi: [v4ModifyLiquidityEvent], data: log.data, topics: topics(log), strict: true });
      return {
        type: "v4_modify_liquidity", blockNumber: log.blockNumber, logIndex: log.logIndex, poolId: args.id,
        tickLower: Number(args.tickLower), tickUpper: Number(args.tickUpper),
        liquidityDelta: args.liquidityDelta, tokenId: tokenIdFromSalt(args.salt),
      };
    }
  }

  return null;
}

/** Topics used to build a single `getLogs` filter for the position tail. */
export const POSITION_LOG_TOPICS: readonly Hex[] = [
  TRANSFER_TOPIC,
  INITIALIZE_TOPIC,
  MODIFY_LIQUIDITY_TOPIC,
  V3_INCREASE_TOPIC,
  V3_DECREASE_TOPIC,
  V3_COLLECT_TOPIC,
];
