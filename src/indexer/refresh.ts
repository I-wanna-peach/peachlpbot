import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import {
  DEX_V4,
  type ChainDescriptor,
  type Dex,
  type V3Venue,
} from "../chains.js";
import { v3FactoryAbi, v3PoolAbi, v3PositionManagerAbi, v4PositionManagerAbi } from "../abi.js";
import type { MulticallContract, MulticallResult, ChainClient } from "../rpc.js";
import type { Store } from "../db/store.js";
import type { PoolRecord, PositionRecord } from "../types.js";
import { decodeV3Position, type V3PositionState } from "./v3-layout.js";

const POOL_KEY_PARAMS = [{
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
}] as const;

const ZERO_ADDRESS = getAddress("0x0000000000000000000000000000000000000000");
const BATCH = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** v4 `PoolId` is `keccak256(abi.encode(PoolKey))`; PoolKey order is load-bearing. */
export function computeV4PoolId(poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_PARAMS, [{
    currency0: poolKey.currency0,
    currency1: poolKey.currency1,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: poolKey.hooks,
  }]));
}

/** The v4 PositionManager packs `[tickUpper | tickLower]` into one uint256. */
export function decodePositionTicks(positionInfo: bigint): { tickLower: number; tickUpper: number } {
  if (positionInfo < 0n || positionInfo >= 1n << 256n) throw new Error("PositionInfo exceeds uint256.");
  const signed24 = (value: bigint): number => {
    const masked = Number(value & 0xffffffn);
    return masked & 0x800000 ? masked - 0x1000000 : masked;
  };
  return { tickLower: signed24(positionInfo >> 8n), tickUpper: signed24(positionInfo >> 32n) };
}

function unwrap<T>(result: MulticallResult<T> | undefined): T | null {
  return result && result.success ? result.result : null;
}

/**
 * Materializes a position's immutable-then-current state (tick range, liquidity,
 * pool identity) by reading it at a pinned head block. This is the only place
 * position *state* is read from the chain, so no historical-state assumption is
 * made and a reorg self-heals on the next read.
 */
export class PositionRefresher {
  readonly #client: ChainClient;
  readonly #store: Store;
  readonly #chain: ChainDescriptor;

  constructor(deps: { client: ChainClient; store: Store; chain: ChainDescriptor }) {
    this.#client = deps.client;
    this.#store = deps.store;
    this.#chain = deps.chain;
  }

  async refreshOwner(owner: Address): Promise<number> {
    const owned = await this.#store.tokenIdsByOwner(this.#chain.chainId, owner);
    if (owned.length === 0) return 0;
    const block = await this.#client.getBlockNumber();
    const blockHash = (await this.#client.getBlock(block)).hash;

    const v4 = owned.filter((entry) => entry.dex === DEX_V4).map((entry) => entry.tokenId);
    const v3Groups = new Map<string, bigint[]>();
    for (const entry of owned) {
      if (entry.dex === DEX_V4) continue;
      const tokenIds = v3Groups.get(entry.dex) ?? [];
      tokenIds.push(entry.tokenId);
      v3Groups.set(entry.dex, tokenIds);
    }

    const jobs: Promise<number>[] = [];
    if (v4.length > 0) jobs.push(this.refreshV4(v4, block, blockHash, owner));
    for (const [dex, tokenIds] of v3Groups) {
      const venue = this.#chain.v3Venues.find((candidate) => candidate.dex === dex);
      if (venue !== undefined) jobs.push(this.refreshV3(venue, tokenIds, block, blockHash, owner));
    }
    const results = await Promise.all(jobs);
    return results.reduce((sum, value) => sum + value, 0);
  }

  async refreshV4(tokenIds: readonly bigint[], block: bigint, blockHash: Hex, expectedOwner: Address): Promise<number> {
    const v4 = this.#chain.v4;
    if (v4 === null) return 0;
    let materialized = 0;
    for (const batch of chunk(tokenIds, BATCH)) {
      const calls: MulticallContract[] = [];
      for (const tokenId of batch) {
        calls.push({ address: v4.positionManager, abi: v4PositionManagerAbi, functionName: "ownerOf", args: [tokenId] });
        calls.push({ address: v4.positionManager, abi: v4PositionManagerAbi, functionName: "getPoolAndPositionInfo", args: [tokenId] });
        calls.push({ address: v4.positionManager, abi: v4PositionManagerAbi, functionName: "getPositionLiquidity", args: [tokenId] });
      }
      const results = await this.#client.multicallSafe<unknown>(calls, block);
      const pools: PoolRecord[] = [];
      const positions: PositionRecord[] = [];
      const burned: bigint[] = [];
      const reassigned: { dex: typeof DEX_V4; tokenId: bigint; owner: Address; mintedBlock: bigint; updatedBlock: bigint; blockHash: Hex }[] = [];
      batch.forEach((tokenId, index) => {
        const owner = unwrap(results[index * 3] as MulticallResult<Address> | undefined);
        if (owner === null) {
          // Burned: the token no longer exists. Drop the ownership row and close
          // any materialized position instead of monitoring the last holder.
          burned.push(tokenId);
          return;
        }
        const actualOwner = getAddress(owner);
        if (actualOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
          // Transferred away: update the index and move the materialized row to
          // the real owner, so the previous subscriber stops being alerted.
          reassigned.push({ dex: DEX_V4, tokenId, owner: actualOwner, mintedBlock: block, updatedBlock: block, blockHash });
        }
        const info = unwrap(results[index * 3 + 1] as MulticallResult<readonly [PoolKeyResult, bigint]> | undefined);
        const liquidity = unwrap(results[index * 3 + 2] as MulticallResult<bigint> | undefined);
        if (info === null || liquidity === null) return;
        const [poolKey, packed] = info;
        const { tickLower, tickUpper } = decodePositionTicks(BigInt(packed));
        const poolRef = computeV4PoolId(poolKey);
        positions.push({
          chainId: this.#chain.chainId, dex: DEX_V4, tokenId, owner: actualOwner, poolRef,
          currency0: getAddress(poolKey.currency0), currency1: getAddress(poolKey.currency1),
          fee: Number(poolKey.fee), tickSpacing: Number(poolKey.tickSpacing), hooks: getAddress(poolKey.hooks),
          tickLower, tickUpper, liquidity: BigInt(liquidity),
          status: BigInt(liquidity) === 0n ? "CLOSED" : "ACTIVE",
          rangeState: "UNKNOWN", outStreak: 0, inStreak: 0, stateVersion: 0, lastEvalBlock: null,
          openedBlock: block, updatedBlock: block, updatedBlockHash: blockHash,
        });
        pools.push({
          chainId: this.#chain.chainId, dex: DEX_V4, poolRef,
          currency0: getAddress(poolKey.currency0), currency1: getAddress(poolKey.currency1),
          fee: Number(poolKey.fee), tickSpacing: Number(poolKey.tickSpacing), hooks: getAddress(poolKey.hooks),
          currentTick: null, sqrtPriceX96: null, liquidity: null, initialized: true,
        });
        if (actualOwner.toLowerCase() === expectedOwner.toLowerCase()) materialized += 1;
      });
      if (burned.length > 0) {
        await this.#store.deletePositionOwners(this.#chain.chainId, DEX_V4, burned);
        await this.#store.syncPositionOwnership(this.#chain.chainId, DEX_V4, [], burned, block, blockHash);
      }
      if (reassigned.length > 0) {
        await this.#store.upsertPositionOwners(this.#chain.chainId, reassigned);
        await this.#store.syncPositionOwnership(this.#chain.chainId, DEX_V4, reassigned.map((entry) => entry.tokenId), [], block, blockHash);
      }
      await this.#store.upsertPools(pools);
      await this.#store.upsertPositions(positions);
    }
    return materialized;
  }

  async refreshV3(
    venue: V3Venue,
    tokenIds: readonly bigint[],
    block: bigint,
    blockHash: Hex,
    expectedOwner: Address,
  ): Promise<number> {
    let materialized = 0;
    for (const batch of chunk(tokenIds, BATCH)) {
      const calls: MulticallContract[] = [];
      for (const tokenId of batch) {
        calls.push({ address: venue.positionManager, abi: v3PositionManagerAbi, functionName: "ownerOf", args: [tokenId] });
        calls.push({ address: venue.positionManager, abi: v3PositionManagerAbi, functionName: "positions", args: [tokenId] });
      }
      const results = await this.#client.multicallSafe<unknown>(calls, block);
      const rows: (V3PositionState & { tokenId: bigint; owner: Address })[] = [];
      const burned: bigint[] = [];
      const reassigned: { dex: Dex; tokenId: bigint; owner: Address; mintedBlock: bigint; updatedBlock: bigint; blockHash: Hex }[] = [];
      batch.forEach((tokenId, index) => {
        const owner = unwrap(results[index * 2] as MulticallResult<Address> | undefined);
        if (owner === null) {
          burned.push(tokenId);
          return;
        }
        const actualOwner = getAddress(owner);
        if (actualOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
          reassigned.push({ dex: venue.dex, tokenId, owner: actualOwner, mintedBlock: block, updatedBlock: block, blockHash });
        }
        const position = unwrap(results[index * 2 + 1] as MulticallResult<readonly unknown[]> | undefined);
        if (position === null) return;
        rows.push({ tokenId, owner: actualOwner, ...decodeV3Position(position) });
      });
      if (burned.length > 0) {
        await this.#store.deletePositionOwners(this.#chain.chainId, venue.dex, burned);
        await this.#store.syncPositionOwnership(this.#chain.chainId, venue.dex, [], burned, block, blockHash);
      }
      if (reassigned.length > 0) {
        await this.#store.upsertPositionOwners(this.#chain.chainId, reassigned);
        await this.#store.syncPositionOwnership(this.#chain.chainId, venue.dex, reassigned.map((entry) => entry.tokenId), [], block, blockHash);
      }
      if (rows.length === 0) continue;

      // Uniswap and PancakeSwap both key pools by fee tier.
      const poolCalls: MulticallContract[] = rows.map((row) => ({
        address: venue.factory,
        abi: v3FactoryAbi,
        functionName: "getPool" as const,
        args: [row.token0, row.token1, row.fee],
      }));
      const poolResults = await this.#client.multicallSafe<Address>(poolCalls, block);
      const poolAddresses = rows.map((_, index) => unwrap(poolResults[index] as MulticallResult<Address> | undefined));

      const spacingCalls: MulticallContract[] = [];
      const spacingIndex: number[] = [];
      poolAddresses.forEach((pool, index) => {
        if (pool === null || /^0x0+$/.test(pool)) return;
        spacingIndex.push(index);
        spacingCalls.push({ address: pool, abi: v3PoolAbi, functionName: "tickSpacing", args: [] });
      });
      const spacingResults = spacingCalls.length === 0 ? [] : await this.#client.multicallSafe<number>(spacingCalls, block);
      const spacing = new Map<number, number>();
      spacingIndex.forEach((rowIndex, callIndex) => {
        const value = unwrap(spacingResults[callIndex] as MulticallResult<number> | undefined);
        if (value !== null) spacing.set(rowIndex, Number(value));
      });

      const pools: PoolRecord[] = [];
      const positions: PositionRecord[] = [];
      rows.forEach((row, index) => {
        const pool = poolAddresses[index] ?? null;
        const tickSpacing = spacing.get(index);
        if (pool === null || tickSpacing === undefined || tickSpacing <= 0 || /^0x0+$/.test(pool)) return;
        const poolRef = pool.toLowerCase();
        pools.push({
          chainId: this.#chain.chainId, dex: venue.dex, poolRef, currency0: row.token0, currency1: row.token1,
          fee: row.fee, tickSpacing, hooks: ZERO_ADDRESS,
          currentTick: null, sqrtPriceX96: null, liquidity: null, initialized: true,
        });
        positions.push({
          chainId: this.#chain.chainId, dex: venue.dex, tokenId: row.tokenId, owner: row.owner, poolRef,
          currency0: row.token0, currency1: row.token1, fee: row.fee, tickSpacing,
          hooks: ZERO_ADDRESS,
          tickLower: row.tickLower, tickUpper: row.tickUpper, liquidity: row.liquidity,
          status: row.liquidity === 0n ? "CLOSED" : "ACTIVE",
          rangeState: "UNKNOWN", outStreak: 0, inStreak: 0, stateVersion: 0, lastEvalBlock: null,
          openedBlock: block, updatedBlock: block, updatedBlockHash: blockHash,
        });
        if (row.owner.toLowerCase() === expectedOwner.toLowerCase()) materialized += 1;
      });
      await this.#store.upsertPools(pools);
      await this.#store.upsertPositions(positions);
    }
    return materialized;
  }
}

interface PoolKeyResult {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}
