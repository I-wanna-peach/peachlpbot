import { getAddress, type Address } from "viem";
import { DEX_V4, type ChainDescriptor, type Dex } from "../chains.js";
import type { ChainConfig } from "../config.js";
import type { PositionEventRow, Store } from "../db/store.js";
import type { TokenMetadataCache } from "../chain/token-metadata.js";
import type { ChainClient } from "../rpc.js";
import type { ChainLog, IncidentRecord, TokenInfo } from "../types.js";
import { decodeLog, POSITION_LOG_TOPICS, TRANSFER_SELECTOR } from "./decode.js";
import { mergePositionChange, type PendingPositionChange } from "./position-changes.js";
import { PositionRefresher } from "./refresh.js";
import { bootstrapStartBlock } from "./window.js";

const STREAM = "positions";
const ZERO_ADDRESS = getAddress("0x0000000000000000000000000000000000000000");

type UnresolvedPositionChange = Omit<PendingPositionChange, "owner">;

/**
 * Maintains the per-chain ownership index (`position_owners`) from ERC-721
 * Transfer logs, and tracks which materialized positions must be re-read at head
 * because a liquidity-bearing event (`ModifyLiquidity` for v4, `Increase`/
 * `Decrease`/`Collect` for v3) or a transfer touched them.
 *
 * It does NOT reconstruct tick ranges from history: a position's tick range is
 * read once at a pinned head block by `PositionRefresher`. Outside the near-head
 * tail only v4 transfers are pulled, because v3 ownership is discoverable through
 * ERC721Enumerable and does not need a historical transfer mirror.
 */
export class PositionIndexer {
  readonly #client: ChainClient;
  readonly #store: Store;
  readonly #refresher: PositionRefresher;
  readonly #config: ChainConfig;
  readonly #chain: ChainDescriptor;
  readonly #tokens: TokenMetadataCache;
  readonly #dirtyOwners = new Set<string>();

  constructor(deps: {
    client: ChainClient;
    store: Store;
    refresher: PositionRefresher;
    config: ChainConfig;
    chain: ChainDescriptor;
    tokens: TokenMetadataCache;
  }) {
    this.#client = deps.client;
    this.#store = deps.store;
    this.#refresher = deps.refresher;
    this.#config = deps.config;
    this.#chain = deps.chain;
    this.#tokens = deps.tokens;
  }

  async runOnce(): Promise<{ processedChunks: number; atHead: boolean; refreshedOwners: number }> {
    const head = await this.#client.getBlockNumber();
    const cursor = await this.#store.getCursor(this.#chain.chainId, STREAM);
    // Cost-bounded bootstrap: without an explicit start block, history older than
    // the lookback window is deliberately NOT indexed. Old positions are allowed
    // to be untracked rather than paying for a genesis-to-head transfer scan.
    const firstBlock = bootstrapStartBlock({
      head,
      startBlock: this.#config.indexer.startBlock,
      lookbackBlocks: this.#config.indexer.lookbackBlocks,
    });
    let from = cursor === null ? firstBlock : cursor.lastBlock + 1n;

    if (cursor !== null && cursor.lastBlock <= head) {
      const block = await this.#client.getBlock(cursor.lastBlock);
      if (block.hash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
        // A shallow reorg: rewind a bounded window and re-apply. Transfers are
        // idempotent (the upsert keeps the newest block), and materialized
        // positions self-heal because they are always re-read at head.
        from = cursor.lastBlock > this.#config.indexer.reorgRewind
          ? cursor.lastBlock - this.#config.indexer.reorgRewind
          : 0n;
      }
    }

    const watched = new Set((await this.#store.watchedAddresses()).map((address) => address.toLowerCase()));
    // The first run is the initial backfill. It must inventory history without
    // replaying recent openings/closures as live alerts.
    const notifyEnabled = cursor !== null;
    const changes = new Map<string, PendingPositionChange>();
    const v3Managers = this.#chain.v3Venues.map((venue) => venue.positionManager);
    const v4 = this.#chain.v4;
    const maxChunks = Math.max(1, this.#config.indexer.maxChunksPerRun);
    let processedChunks = 0;

    while (from <= head && processedChunks < maxChunks) {
      const to = from + this.#config.indexer.chunkSize - 1n > head ? head : from + this.#config.indexer.chunkSize - 1n;
      const nearHead = to + this.#config.indexer.tailWindowBlocks >= head;
      const addresses = nearHead
        ? [...v3Managers, ...(v4 === null ? [] : [v4.positionManager, v4.poolManager])]
        : (v4 === null ? [] : [v4.positionManager]);
      const topics = nearHead ? [POSITION_LOG_TOPICS] : [[TRANSFER_SELECTOR]];
      const logs = addresses.length === 0
        ? []
        : await this.#client.getLogs({ address: addresses, topics, fromBlock: from, toBlock: to });
      await this.#applyChunk(logs, watched, nearHead && notifyEnabled, changes);
      const block = await this.#client.getBlock(to);
      await this.#store.setCursor(this.#chain.chainId, STREAM, { lastBlock: to, lastBlockHash: block.hash });
      from = to + 1n;
      processedChunks += 1;
    }

    const refreshedOwners = await this.#flushDirty();
    if (changes.size > 0) await this.#emitPositionChanges(changes, watched);
    return { processedChunks, atHead: from > head, refreshedOwners };
  }

  /** Safety net: re-materialize every watched address (catches edits with no event). */
  async sweepWatchedOwners(): Promise<number> {
    const watched = await this.#store.watchedAddresses();
    let refreshed = 0;
    for (const owner of watched) refreshed += await this.#refresher.refreshOwner(owner);
    return refreshed;
  }

  async #flushDirty(): Promise<number> {
    if (this.#dirtyOwners.size === 0) return 0;
    const owners = [...this.#dirtyOwners];
    this.#dirtyOwners.clear();
    let refreshed = 0;
    for (const owner of owners) refreshed += await this.#refresher.refreshOwner(owner as Address);
    return refreshed;
  }

  async #applyChunk(
    logs: readonly ChainLog[],
    watched: ReadonlySet<string>,
    notify: boolean,
    changes: Map<string, PendingPositionChange>,
  ): Promise<void> {
    const chainId = this.#chain.chainId;
    const ownerRows: { dex: Dex; tokenId: bigint; owner: Address; mintedBlock: bigint; updatedBlock: bigint; blockHash: `0x${string}` }[] = [];
    const events: PositionEventRow[] = [];
    const dirtyTokens = new Map<Dex, Set<string>>();
    const transfers = new Map<Dex, { reassigned: Set<string>; burned: Set<string> }>();
    const dirtyFor = (dex: Dex): Set<string> => {
      let tokens = dirtyTokens.get(dex);
      if (tokens === undefined) {
        tokens = new Set();
        dirtyTokens.set(dex, tokens);
      }
      return tokens;
    };
    const transfersFor = (dex: Dex): { reassigned: Set<string>; burned: Set<string> } => {
      let state = transfers.get(dex);
      if (state === undefined) {
        state = { reassigned: new Set(), burned: new Set() };
        transfers.set(dex, state);
      }
      return state;
    };
    const tokenOwners = new Map<string, Address>();
    const liquidityChanges: UnresolvedPositionChange[] = [];

    for (const log of logs) {
      const event = decodeLog(log, this.#chain);
      if (event === null) continue;

      if (event.type === "v4_transfer" || event.type === "v3_transfer") {
        const dex: Dex = event.type === "v4_transfer" ? DEX_V4 : event.dex;
        const isMint = event.from === ZERO_ADDRESS;
        const isBurn = event.to === ZERO_ADDRESS;
        // v3 ownership is authoritative through ERC721Enumerable, so only
        // watched-side transfers are catalogued. v4 is mirrored fully because it
        // has no enumerable view.
        const watchOnly = event.type === "v3_transfer";
        const toWatched = watched.has(event.to.toLowerCase());
        const fromWatched = watched.has(event.from.toLowerCase());
        if (watchOnly && !toWatched && !fromWatched) continue;
        tokenOwners.set(`${dex}:${event.tokenId}`, isBurn ? event.from : event.to);

        if (isBurn) {
          // `to = 0x0` is a burn, not an ownership change: the owner row must be
          // removed and the position closed, otherwise it would be monitored
          // forever under the last holder.
          transfersFor(dex).burned.add(event.tokenId.toString());
        } else if (!watchOnly || toWatched) {
          ownerRows.push({
            dex, tokenId: event.tokenId, owner: event.to,
            mintedBlock: event.blockNumber, updatedBlock: event.blockNumber, blockHash: log.blockHash,
          });
          transfersFor(dex).reassigned.add(event.tokenId.toString());
        } else {
          // A watched position moved to an unwatched address. Drop the owner
          // row and close the materialized row; we no longer monitor it there.
          transfersFor(dex).burned.add(event.tokenId.toString());
        }
        if (!watchOnly || toWatched) dirtyFor(dex).add(event.tokenId.toString());

        events.push({
          chainId, dex, kind: event.type, blockNumber: event.blockNumber, blockHash: log.blockHash,
          transactionHash: log.transactionHash, logIndex: event.logIndex, tokenId: event.tokenId,
          poolRef: null, owner: isBurn ? event.from : event.to,
          tickLower: null, tickUpper: null, liquidityDelta: null,
        });

        if (notify) {
          const base = {
            dex,
            tokenId: event.tokenId,
            blockNumber: event.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: event.logIndex,
            poolRef: null,
            tickLower: null,
            tickUpper: null,
            liquidityDelta: null,
            amount0: null,
            amount1: null,
          };
          if (isMint) {
            mergePositionChange(changes, { ...base, owner: event.to, kind: "OPENED" });
          } else if (isBurn) {
            mergePositionChange(changes, { ...base, owner: event.from, kind: "CLOSED" });
          } else {
            mergePositionChange(changes, { ...base, owner: event.from, kind: "TRANSFERRED_OUT" });
            mergePositionChange(changes, { ...base, owner: event.to, kind: "TRANSFERRED_IN" });
          }
        }
        continue;
      }

      if (event.type === "v4_modify_liquidity" && event.tokenId !== null) {
        dirtyFor(DEX_V4).add(event.tokenId.toString());
        events.push({
          chainId, dex: DEX_V4, kind: event.type, blockNumber: event.blockNumber, blockHash: log.blockHash,
          transactionHash: log.transactionHash, logIndex: event.logIndex, tokenId: event.tokenId,
          poolRef: event.poolId, owner: null, tickLower: event.tickLower, tickUpper: event.tickUpper,
          liquidityDelta: event.liquidityDelta,
        });
        if (notify) {
          // A zero delta is how the v4 PositionManager signals a collect.
          liquidityChanges.push({
            dex: DEX_V4,
            tokenId: event.tokenId,
            kind: event.liquidityDelta > 0n ? "INCREASED" : event.liquidityDelta < 0n ? "DECREASED" : "COLLECTED",
            blockNumber: event.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: event.logIndex,
            poolRef: event.poolId,
            tickLower: event.tickLower,
            tickUpper: event.tickUpper,
            liquidityDelta: event.liquidityDelta,
            amount0: null,
            amount1: null,
          });
        }
        continue;
      }

      if (event.type === "v3_increase" || event.type === "v3_decrease") {
        dirtyFor(event.dex).add(event.tokenId.toString());
        events.push({
          chainId, dex: event.dex, kind: event.type, blockNumber: event.blockNumber, blockHash: log.blockHash,
          transactionHash: log.transactionHash, logIndex: event.logIndex, tokenId: event.tokenId,
          poolRef: null, owner: null, tickLower: null, tickUpper: null,
          liquidityDelta: event.type === "v3_increase" ? event.liquidity : -event.liquidity,
        });
        if (notify) {
          liquidityChanges.push({
            dex: event.dex,
            tokenId: event.tokenId,
            kind: event.type === "v3_increase" ? "INCREASED" : "DECREASED",
            blockNumber: event.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: event.logIndex,
            poolRef: null,
            tickLower: null,
            tickUpper: null,
            liquidityDelta: event.type === "v3_increase" ? event.liquidity : -event.liquidity,
            amount0: null,
            amount1: null,
          });
        }
        continue;
      }

      if (event.type === "v3_collect") {
        dirtyFor(event.dex).add(event.tokenId.toString());
        events.push({
          chainId, dex: event.dex, kind: event.type, blockNumber: event.blockNumber, blockHash: log.blockHash,
          transactionHash: log.transactionHash, logIndex: event.logIndex, tokenId: event.tokenId,
          poolRef: null, owner: null, tickLower: null, tickUpper: null, liquidityDelta: null,
        });
        if (notify) {
          liquidityChanges.push({
            dex: event.dex,
            tokenId: event.tokenId,
            kind: "COLLECTED",
            blockNumber: event.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: event.logIndex,
            poolRef: null,
            tickLower: null,
            tickUpper: null,
            liquidityDelta: null,
            amount0: event.amount0,
            amount1: event.amount1,
          });
        }
      }
    }

    await this.#store.upsertPositionOwners(chainId, ownerRows);
    const lastLog = logs[logs.length - 1];
    if (lastLog !== undefined) {
      for (const dex of this.#dexes()) {
        const state = transfersFor(dex);
        // A token can be transferred and then burned within one chunk; the burn wins.
        for (const token of state.burned) state.reassigned.delete(token);
        const burned = [...state.burned].map((value) => BigInt(value));
        const reassigned = [...state.reassigned].map((value) => BigInt(value));
        if (burned.length > 0) await this.#store.deletePositionOwners(chainId, dex, burned);
        if (burned.length > 0 || reassigned.length > 0) {
          await this.#store.syncPositionOwnership(chainId, dex, reassigned, burned, lastLog.blockNumber, lastLog.blockHash);
        }
      }
    }
    await this.#store.insertPositionEvents(events);

    // Mark watched owners of touched tokens dirty for a head re-read.
    const ownersByDex = new Map<Dex, Map<string, Address>>();
    for (const dex of this.#dexes()) {
      const tokenIds = [...(dirtyTokens.get(dex) ?? [])].map((value) => BigInt(value));
      if (tokenIds.length === 0) continue;
      const owners = await this.#store.ownersForTokens(chainId, dex, tokenIds);
      ownersByDex.set(dex, owners);
      for (const owner of owners.values()) {
        if (watched.has(owner.toLowerCase())) this.#dirtyOwners.add(owner.toLowerCase());
      }
    }
    // A transfer TO a watched address may be a brand-new position not yet owned before.
    for (const row of ownerRows) {
      if (watched.has(row.owner.toLowerCase())) this.#dirtyOwners.add(row.owner.toLowerCase());
    }

    // Liquidity events do not carry the owner; resolve it from the same chunk's
    // transfers first (mints/burns included), then from the ownership index.
    for (const change of liquidityChanges) {
      const owner = tokenOwners.get(`${change.dex}:${change.tokenId}`)
        ?? ownersByDex.get(change.dex)?.get(change.tokenId.toString())
        ?? null;
      if (owner === null) continue;
      mergePositionChange(changes, { ...change, owner });
    }
  }

  #dexes(): Dex[] {
    return [...this.#chain.v3Venues.map((venue) => venue.dex), ...(this.#chain.v4 === null ? [] : [DEX_V4])];
  }

  async #emitPositionChanges(
    changes: ReadonlyMap<string, PendingPositionChange>,
    watched: ReadonlySet<string>,
  ): Promise<void> {
    const relevant = [...changes.values()].filter((change) => watched.has(change.owner.toLowerCase()));
    if (relevant.length === 0) return;

    // Rows are materialized by #flushDirty above, so a freshly minted position
    // already has its pool, currencies and range.
    const positions = await this.#store.findPositionsByTokens(
      this.#chain.chainId,
      relevant.map((change) => ({ dex: change.dex, tokenId: change.tokenId })),
    );
    let metadata = new Map<string, TokenInfo>();
    try {
      metadata = await this.#tokens.get(
        [...positions.values()].flatMap((position) => [position.currency0, position.currency1]),
      );
    } catch {
      // Symbols are decorative; the notice still carries the pool and ticks.
    }

    const incidents: IncidentRecord[] = [];
    for (const change of relevant) {
      const position = positions.get(`${change.dex}:${change.tokenId}`);
      const poolRef = change.poolRef ?? position?.poolRef ?? null;
      if (poolRef === null) continue;
      const currency0 = position?.currency0 ?? null;
      const currency1 = position?.currency1 ?? null;
      // A decrease that leaves zero liquidity is a full withdrawal, not a trim.
      const kind = change.kind === "DECREASED" && position?.liquidity === 0n ? "CLOSED" : change.kind;
      incidents.push({
        chainId: this.#chain.chainId,
        idempotencyKey: `${this.#chain.chainId}:LP_POSITION_CHANGED:${change.dex}:${change.tokenId}:${change.transactionHash.toLowerCase()}:${kind}`,
        type: "LP_POSITION_CHANGED",
        dex: change.dex,
        poolRef,
        tokenId: change.tokenId,
        owner: change.owner,
        fromState: null,
        toState: null,
        stateVersion: change.logIndex,
        blockNumber: change.blockNumber,
        blockHash: change.blockHash,
        payload: {
          kind,
          tokenId: change.tokenId.toString(),
          dex: change.dex,
          poolRef,
          currency0,
          currency1,
          symbol0: currency0 === null ? null : metadata.get(currency0.toLowerCase())?.symbol ?? null,
          symbol1: currency1 === null ? null : metadata.get(currency1.toLowerCase())?.symbol ?? null,
          tickLower: change.tickLower ?? position?.tickLower ?? null,
          tickUpper: change.tickUpper ?? position?.tickUpper ?? null,
          liquidityDelta: change.liquidityDelta === null ? null : change.liquidityDelta.toString(),
          amount0: change.amount0 === null ? null : change.amount0.toString(),
          amount1: change.amount1 === null ? null : change.amount1.toString(),
          transactionHash: change.transactionHash,
          blockNumber: change.blockNumber.toString(),
          chainId: this.#chain.chainId.toString(),
          chainLabel: this.#chain.shortLabel,
          explorerTxUrl: `${this.#chain.explorerUrl}/tx/${change.transactionHash}`,
        },
      });
    }

    if (incidents.length > 0) await this.#store.recordRound(this.#chain.chainId, [], incidents);
  }
}
