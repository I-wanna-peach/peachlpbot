import { getAddress, type Address, type Hex } from "viem";
import { DEX_V4, type ChainDescriptor, type V3Venue } from "../chains.js";
import { erc721EnumerableAbi } from "../abi.js";
import type { ChainConfig } from "../config.js";
import type { ChainClient } from "../rpc.js";
import type { Store } from "../db/store.js";
import type { PositionRefresher } from "./refresh.js";
import { TRANSFER_SELECTOR } from "./decode.js";
import { bootstrapStartBlock } from "./window.js";

const MAX_ENUMERATED = 500;
/**
 * A multi-million-block owner-filtered getLogs is slow and plan-limited. A
 * subscription therefore reads what the global transfer index has catalogued and
 * additionally scans this recent window; older history is left to the background
 * backfill cursor.
 */
const RECENT_SCAN_BLOCKS = 200_000n;

export interface DiscoveryResult {
  /** Positions materialized for the owner right now (all venues). */
  positions: number;
  /** How far the v4 ownership index still is from head, if it has started. */
  indexLagBlocks: bigint | null;
  /** True when older v4 history has not been catalogued yet. */
  partial: boolean;
}

function ownerTopic(owner: Address): Hex {
  return `0x000000000000000000000000${owner.slice(2).toLowerCase()}` as Hex;
}

function unwrap<T>(value: { success: true; result: T } | { success: false; reason: string } | undefined): T | null {
  return value && value.success ? value.result : null;
}

/**
 * Immediate, per-address discovery used when a chat subscribes and by the
 * periodic sweep.
 *
 * - v3 venues are ERC-721 Enumerable, so they are enumerated directly at head.
 * - v4 is NOT enumerable, so it is discovered from PositionManager `Transfer`
 *   logs filtered by the recipient topic, then verified with `ownerOf` (a token
 *   that was received and later sent away must not be reported).
 *
 * Discovered ownership is written to `position_owners`; tick ranges come from the
 * shared `PositionRefresher` head read, never from historical state.
 */
export class OwnerDiscovery {
  readonly #client: ChainClient;
  readonly #store: Store;
  readonly #refresher: PositionRefresher;
  readonly #chain: ChainDescriptor;
  readonly #config: ChainConfig;

  constructor(deps: {
    client: ChainClient;
    store: Store;
    refresher: PositionRefresher;
    chain: ChainDescriptor;
    config: ChainConfig;
  }) {
    this.#client = deps.client;
    this.#store = deps.store;
    this.#refresher = deps.refresher;
    this.#chain = deps.chain;
    this.#config = deps.config;
  }

  async discover(owner: Address): Promise<DiscoveryResult> {
    const blockNumber = await this.#client.getBlockNumber();
    const block = await this.#client.getBlock(blockNumber);
    const cursor = await this.#store.getCursor(this.#chain.chainId, "positions");
    const indexLagBlocks = cursor === null ? null : blockNumber - cursor.lastBlock;

    const [v3, v4] = await Promise.all([
      this.#discoverV3Venues(owner, blockNumber, block.hash),
      this.#discoverV4(owner, blockNumber, block.hash),
    ]);
    await this.#store.upsertPositionOwners(this.#chain.chainId, [...v3, ...v4]);
    const positions = await this.#refresher.refreshOwner(owner);
    return {
      positions,
      indexLagBlocks,
      partial: indexLagBlocks === null || indexLagBlocks > RECENT_SCAN_BLOCKS,
    };
  }

  async #discoverV3Venues(owner: Address, blockNumber: bigint, blockHash: Hex) {
    const rows = await Promise.all(this.#chain.v3Venues.map((venue) => (
      this.#discoverV3(venue, owner, blockNumber, blockHash)
    )));
    return rows.flat();
  }

  async #discoverV3(venue: V3Venue, owner: Address, blockNumber: bigint, blockHash: Hex) {
    const balance = await this.#client.multicall<bigint>([{
      address: venue.positionManager, abi: erc721EnumerableAbi, functionName: "balanceOf", args: [owner],
    }], blockNumber);
    const count = Number(balance[0] ?? 0n);
    if (count <= 0) return [];
    if (count > MAX_ENUMERATED) throw new Error(`Address owns ${count} ${venue.dex} positions; refusing to enumerate more than ${MAX_ENUMERATED}.`);
    const calls = Array.from({ length: count }, (_, index) => ({
      address: venue.positionManager,
      abi: erc721EnumerableAbi,
      functionName: "tokenOfOwnerByIndex" as const,
      args: [owner, BigInt(index)],
    }));
    const tokenIds = await this.#client.multicall<bigint>(calls, blockNumber);
    return tokenIds.map((tokenId) => ({
      dex: venue.dex,
      tokenId: BigInt(tokenId),
      owner,
      mintedBlock: blockNumber,
      updatedBlock: blockNumber,
      blockHash,
    }));
  }

  async #discoverV4(owner: Address, blockNumber: bigint, blockHash: Hex) {
    const v4 = this.#chain.v4;
    if (v4 === null) return [];

    const configuredStart = bootstrapStartBlock({
      head: blockNumber,
      startBlock: this.#config.indexer.startBlock,
      lookbackBlocks: this.#config.indexer.lookbackBlocks,
    });
    const recentStart = blockNumber > RECENT_SCAN_BLOCKS ? blockNumber - RECENT_SCAN_BLOCKS : 0n;
    const fromBlock = configuredStart > recentStart ? configuredStart : recentStart;
    const logs = await this.#client.getLogs({
      address: v4.positionManager,
      topics: [TRANSFER_SELECTOR, null, ownerTopic(owner)],
      fromBlock,
      toBlock: blockNumber,
    });
    const candidates = [...new Set(logs.map((log) => {
      const topic = log.topics[3];
      if (!topic) throw new Error("ERC-721 Transfer log is missing the tokenId topic.");
      return BigInt(topic).toString();
    }))];
    if (candidates.length === 0) return [];

    // A token received earlier may have been transferred away; `ownerOf` is the
    // authority, and a burned token simply reverts (allowFailure keeps the batch).
    const calls = candidates.map((tokenId) => ({
      address: v4.positionManager,
      abi: erc721EnumerableAbi,
      functionName: "ownerOf" as const,
      args: [BigInt(tokenId)],
    }));
    const results = await this.#client.multicallSafe<Address>(calls, blockNumber);
    const wanted = owner.toLowerCase();
    const rows: {
      dex: typeof DEX_V4;
      tokenId: bigint;
      owner: Address;
      mintedBlock: bigint;
      updatedBlock: bigint;
      blockHash: Hex;
    }[] = [];
    results.forEach((result, index) => {
      const actual = unwrap(result);
      if (actual === null) return;
      if (getAddress(actual).toLowerCase() !== wanted) return;
      rows.push({
        dex: DEX_V4,
        tokenId: BigInt(candidates[index]!),
        owner,
        mintedBlock: blockNumber,
        updatedBlock: blockNumber,
        blockHash,
      });
    });
    return rows;
  }
}
