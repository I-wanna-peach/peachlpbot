import { getAddress, type Hex } from "viem";
import { DEX_V4, type ChainDescriptor, type Dex } from "../chains.js";
import type { MonitorConfig } from "../config.js";
import type { Store, RangeUpdate } from "../db/store.js";
import type { ChainClient, MulticallContract, MulticallResult } from "../rpc.js";
import type { IncidentRecord, PositionRecord, RangeState } from "../types.js";
import { evaluateRange, rangeChanged, shouldNotify } from "./range.js";
import { buildPriceView, type PriceView } from "./price.js";
import { v3PoolAbi, v4StateViewAbi } from "../abi.js";
import type { TokenMetadataCache } from "../chain/token-metadata.js";

interface PoolTick {
  tick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

/**
 * Each pool costs two sub-calls (slot0 + liquidity). 100 pools keeps one
 * aggregate3 comfortably bounded; larger sets are read in sequential batches so
 * a growing subscription base cannot exceed the node's/multicall's limits.
 */
const POOLS_PER_MULTICALL = 100;

function poolKey(dex: Dex, poolRef: string): string {
  return `${dex}:${poolRef}`;
}

/**
 * Follows the chain head: for every ACTIVE position whose owner has an active
 * subscription, reads its pool's tick ONCE per pool per round (grouped), feeds
 * the debounced state machine, and commits range transitions plus their outbox
 * fan-out in one transaction.
 *
 * A pool whose tick cannot be read is left out of the round entirely. Unknown is
 * never coerced into IN_RANGE or OUT_OF_RANGE.
 */
export class TickMonitor {
  readonly #client: ChainClient;
  readonly #store: Store;
  readonly #chain: ChainDescriptor;
  readonly #config: MonitorConfig;
  readonly #tokens: TokenMetadataCache;

  constructor(deps: {
    client: ChainClient;
    store: Store;
    chain: ChainDescriptor;
    config: MonitorConfig;
    tokens: TokenMetadataCache;
  }) {
    this.#client = deps.client;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#config = deps.config;
    this.#tokens = deps.tokens;
  }

  async runOnce(): Promise<{ poolsRead: number; positionsEvaluated: number; incidents: number }> {
    const positions = await this.#store.monitoredPositions(this.#chain.chainId);
    if (positions.length === 0) return { poolsRead: 0, positionsEvaluated: 0, incidents: 0 };

    const currencies = [...new Set(positions.flatMap((position) => [position.currency0, position.currency1]))];
    const metadata = await this.#tokens.get(currencies);

    const blockNumber = await this.#client.getBlockNumber();
    const block = await this.#client.getBlock(blockNumber);

    const groups = new Map<string, { dex: Dex; poolRef: string; positions: PositionRecord[] }>();
    for (const position of positions) {
      const key = poolKey(position.dex, position.poolRef);
      let group = groups.get(key);
      if (!group) {
        group = { dex: position.dex, poolRef: position.poolRef, positions: [] };
        groups.set(key, group);
      }
      group.positions.push(position);
    }

    const ticks = await this.#readPoolTicks(groups, blockNumber);
    const updates: RangeUpdate[] = [];
    const incidents: IncidentRecord[] = [];
    let evaluated = 0;

    for (const [key, group] of groups) {
      const tick = ticks.get(key);
      if (!tick) continue;
      for (const position of group.positions) {
        if (position.lastEvalBlock === blockNumber) continue; // same block, no double count
        evaluated += 1;
        const decision = evaluateRange({
          currentTick: tick.tick,
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          rangeState: position.rangeState,
          outStreak: position.outStreak,
          inStreak: position.inStreak,
          outConfirmBlocks: this.#config.outOfRangeConfirmBlocks,
          inConfirmBlocks: this.#config.inRangeConfirmBlocks,
        });
        if (!rangeChanged({ rangeState: position.rangeState, outStreak: position.outStreak, inStreak: position.inStreak }, decision)) {
          continue;
        }
        const stateVersion = position.stateVersion + (decision.transition === null ? 0 : 1);
        updates.push({
          dex: position.dex,
          tokenId: position.tokenId,
          rangeState: decision.rangeState,
          outStreak: decision.outStreak,
          inStreak: decision.inStreak,
          stateVersion,
          lastEvalBlock: blockNumber,
        });
        const transition = decision.transition;
        if (transition !== null && shouldNotify(transition, this.#config.notifyBackInRange)) {
          const price = buildPriceView({
            chain: this.#chain,
            currency0: position.currency0,
            currency1: position.currency1,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            currentTick: tick.tick,
            tickSpacing: position.tickSpacing,
            metadata,
          });
          incidents.push(this.#rangeIncident(position, decision.rangeState, transition.from, stateVersion, tick.tick, blockNumber, block.hash, price));
        }
      }
    }

    await this.#store.updatePoolTicks(this.#chain.chainId, [...ticks.entries()].map(([key, tick]) => {
      const group = groups.get(key)!;
      return {
        dex: group.dex,
        poolRef: group.poolRef,
        currentTick: tick.tick,
        sqrtPriceX96: tick.sqrtPriceX96,
        liquidity: tick.liquidity,
        block: blockNumber,
        blockHash: block.hash,
      };
    }));

    const created = await this.#store.recordRound(this.#chain.chainId, updates, incidents);
    return { poolsRead: ticks.size, positionsEvaluated: evaluated, incidents: created };
  }

  async #readPoolTicks(
    groups: Map<string, { dex: Dex; poolRef: string; positions: PositionRecord[] }>,
    blockNumber: bigint,
  ): Promise<Map<string, PoolTick>> {
    const entries = [...groups.entries()]
      .map(([key, group]) => ({ key, dex: group.dex, poolRef: group.poolRef }))
      .filter((entry) => entry.dex !== DEX_V4 || this.#chain.v4 !== null);
    const ticks = new Map<string, PoolTick>();
    for (let offset = 0; offset < entries.length; offset += POOLS_PER_MULTICALL) {
      const batch = entries.slice(offset, offset + POOLS_PER_MULTICALL);
      const calls: MulticallContract[] = [];
      for (const entry of batch) {
        if (entry.dex === DEX_V4) {
          const v4 = this.#chain.v4!;
          calls.push({ address: v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [entry.poolRef as Hex] });
          calls.push({ address: v4.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [entry.poolRef as Hex] });
        } else {
          const pool = getAddress(entry.poolRef);
          calls.push({ address: pool, abi: v3PoolAbi, functionName: "slot0", args: [] });
          calls.push({ address: pool, abi: v3PoolAbi, functionName: "liquidity", args: [] });
        }
      }

      const results = await this.#client.multicallSafe<unknown>(calls, blockNumber);
      batch.forEach((entry, index) => {
        const slot0 = unwrap<readonly unknown[]>(results[index * 2]);
        const liquidity = unwrap<bigint>(results[index * 2 + 1]);
        if (slot0 === null || liquidity === null) return;
        const sqrtPriceX96 = BigInt(String(slot0[0]));
        if (sqrtPriceX96 <= 0n) return; // uninitialized pool: no price, no conclusion
        ticks.set(entry.key, { tick: Number(slot0[1]), sqrtPriceX96, liquidity: BigInt(liquidity) });
      });
    }
    return ticks;
  }

  #rangeIncident(
    position: PositionRecord,
    toState: RangeState,
    fromState: RangeState,
    stateVersion: number,
    currentTick: number,
    blockNumber: bigint,
    blockHash: Hex,
    price: PriceView | null,
  ): IncidentRecord {
    const type = toState === "OUT_OF_RANGE" ? "LP_OUT_OF_RANGE" : "LP_BACK_IN_RANGE";
    return {
      chainId: this.#chain.chainId,
      idempotencyKey: `${this.#chain.chainId}:${type}:${position.dex}:${position.poolRef}:${position.tokenId}:${stateVersion}`,
      type,
      dex: position.dex,
      poolRef: position.poolRef,
      tokenId: position.tokenId,
      owner: position.owner,
      fromState,
      toState,
      stateVersion,
      blockNumber,
      blockHash,
      payload: {
        tokenId: position.tokenId.toString(),
        dex: position.dex,
        poolRef: position.poolRef,
        owner: position.owner,
        currency0: position.currency0,
        currency1: position.currency1,
        fee: position.fee,
        currentTick,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        rulesVersion: this.#config.rulesVersion,
        confirmations: type === "LP_OUT_OF_RANGE" ? this.#config.outOfRangeConfirmBlocks : this.#config.inRangeConfirmBlocks,
        price,
        chainId: this.#chain.chainId.toString(),
        chainLabel: this.#chain.shortLabel,
      },
    };
  }
}

function unwrap<T>(result: MulticallResult<unknown> | undefined): T | null {
  return result && result.success ? (result.result as T) : null;
}
