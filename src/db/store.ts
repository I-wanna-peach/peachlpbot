import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import type { Database } from "./client.js";
import { asBigInt, asNumber, bytesHex, hexBytes } from "../bytes.js";
import type { Dex } from "../chains.js";
import type {
  DeliveryStatus,
  IncidentRecord,
  PoolRecord,
  PositionRecord,
  RangeState,
  TokenInfo,
} from "../types.js";

export interface Cursor {
  lastBlock: bigint;
  lastBlockHash: Hex;
}

/** One row of the append-only `position_events` table. */
export interface PositionEventRow {
  chainId: bigint;
  dex: Dex;
  kind: string;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  tokenId: bigint | null;
  poolRef: string | null;
  owner: Address | null;
  tickLower: number | null;
  tickUpper: number | null;
  liquidityDelta: bigint | null;
}

/** The fields the monitor changes on a position in one round. */
export interface RangeUpdate {
  dex: Dex;
  tokenId: bigint;
  rangeState: RangeState;
  outStreak: number;
  inStreak: number;
  stateVersion: number;
  lastEvalBlock: bigint;
}

export interface DueDelivery {
  id: string;
  incidentId: string;
  telegramChatId: string;
  attempts: number;
  type: IncidentRecord["type"];
  payload: Record<string, unknown>;
  subscriptionId: string;
  nickname: string | null;
}

export interface SubscriptionRow {
  id: string;
  telegramChatId: string;
  watchedAddress: Address;
  nickname: string | null;
  status: "ACTIVE" | "REVOKED";
}

/**
 * PostgreSQL caps bind parameters at 65,534 per statement. A dense chunk can
 * exceed that with one row per event, so bulk writes are split.
 */
function insertBatches<T>(rows: readonly T[], columnsPerRow: number, maxParameters = 60_000): T[][] {
  const perBatch = Math.max(1, Math.floor(maxParameters / columnsPerRow));
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += perBatch) batches.push(rows.slice(index, index + perBatch));
  return batches;
}

function positionRow(row: Record<string, unknown>): PositionRecord {
  return {
    chainId: asBigInt(row.chain_id),
    dex: String(row.dex) as Dex,
    tokenId: asBigInt(row.token_id),
    owner: getAddress(bytesHex(row.owner as Uint8Array)),
    poolRef: String(row.pool_ref),
    currency0: getAddress(bytesHex(row.currency0 as Uint8Array)),
    currency1: getAddress(bytesHex(row.currency1 as Uint8Array)),
    fee: asNumber(row.fee),
    tickSpacing: asNumber(row.tick_spacing),
    hooks: getAddress(bytesHex(row.hooks as Uint8Array)),
    tickLower: asNumber(row.tick_lower),
    tickUpper: asNumber(row.tick_upper),
    liquidity: asBigInt(row.liquidity),
    status: String(row.status) as PositionRecord["status"],
    rangeState: String(row.range_state) as RangeState,
    outStreak: asNumber(row.out_streak),
    inStreak: asNumber(row.in_streak),
    stateVersion: asNumber(row.state_version),
    lastEvalBlock: row.last_eval_block === null ? null : asBigInt(row.last_eval_block),
    openedBlock: asBigInt(row.opened_block),
    updatedBlock: asBigInt(row.updated_block),
    updatedBlockHash: bytesHex(row.updated_block_hash as Uint8Array),
  };
}

export class Store {
  readonly #sql: Database;

  constructor(sql: Database) {
    this.#sql = sql;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }

  // --- cursors -------------------------------------------------------------

  async getCursor(chainId: bigint, stream: string): Promise<Cursor | null> {
    const rows = await this.#sql`
      SELECT last_block, last_block_hash FROM indexer_cursors
      WHERE chain_id = ${chainId.toString()} AND stream = ${stream}
    `;
    const row = rows[0];
    if (!row) return null;
    return { lastBlock: asBigInt(row.last_block), lastBlockHash: bytesHex(row.last_block_hash as Uint8Array) };
  }

  async setCursor(chainId: bigint, stream: string, cursor: Cursor): Promise<void> {
    await this.#sql`
      INSERT INTO indexer_cursors (chain_id, stream, last_block, last_block_hash, updated_at)
      VALUES (${chainId.toString()}, ${stream}, ${cursor.lastBlock.toString()}, ${hexBytes(cursor.lastBlockHash)}, now())
      ON CONFLICT (chain_id, stream) DO UPDATE
      SET last_block = EXCLUDED.last_block, last_block_hash = EXCLUDED.last_block_hash, updated_at = now()
    `;
  }

  // --- pools ---------------------------------------------------------------

  async upsertPools(pools: readonly PoolRecord[]): Promise<void> {
    if (pools.length === 0) return;
    // One chunk can reference the same pool from several positions. PostgreSQL
    // rejects a bulk INSERT .. ON CONFLICT that hits the same key twice, so the
    // last row per (dex, pool_ref) wins before it reaches SQL.
    const unique = new Map<string, PoolRecord>();
    for (const pool of pools) unique.set(`${pool.dex}:${pool.poolRef}`, pool);
    const rows = [...unique.values()].map((pool) => ({
      chain_id: pool.chainId.toString(),
      dex: pool.dex,
      pool_ref: pool.poolRef,
      currency0: hexBytes(pool.currency0),
      currency1: hexBytes(pool.currency1),
      fee: pool.fee,
      tick_spacing: pool.tickSpacing,
      hooks: hexBytes(pool.hooks),
      current_tick: pool.currentTick,
      sqrt_price_x96: pool.sqrtPriceX96 === null ? null : pool.sqrtPriceX96.toString(),
      liquidity: pool.liquidity === null ? null : pool.liquidity.toString(),
      initialized: pool.initialized,
    }));
    for (const batch of insertBatches(rows, 13)) {
      await this.#sql`
        INSERT INTO pools ${this.#sql(batch, "chain_id", "dex", "pool_ref", "currency0", "currency1",
          "fee", "tick_spacing", "hooks", "current_tick", "sqrt_price_x96", "liquidity", "initialized")}
        ON CONFLICT (chain_id, dex, pool_ref) DO UPDATE SET
          currency0 = EXCLUDED.currency0, currency1 = EXCLUDED.currency1,
          fee = EXCLUDED.fee, tick_spacing = EXCLUDED.tick_spacing, hooks = EXCLUDED.hooks,
          updated_at = now()
      `;
    }
  }

  async updatePoolTicks(chainId: bigint, updates: readonly {
    dex: Dex; poolRef: string; currentTick: number; sqrtPriceX96: bigint; liquidity: bigint; block: bigint; blockHash: Hex;
  }[]): Promise<void> {
    if (updates.length === 0) return;
    await this.#sql.begin(async (tx) => {
      for (const update of updates) {
        await tx`
          UPDATE pools SET current_tick = ${update.currentTick},
            sqrt_price_x96 = ${update.sqrtPriceX96.toString()},
            liquidity = ${update.liquidity.toString()}, last_checked_block = ${update.block.toString()},
            last_checked_block_hash = ${hexBytes(update.blockHash)}, updated_at = now()
          WHERE chain_id = ${chainId.toString()} AND dex = ${update.dex} AND pool_ref = ${update.poolRef}
        `;
      }
    });
  }

  // --- positions -----------------------------------------------------------

  async upsertPositions(positions: readonly PositionRecord[]): Promise<void> {
    if (positions.length === 0) return;
    const unique = new Map<string, PositionRecord>();
    for (const position of positions) unique.set(`${position.dex}:${position.tokenId}`, position);
    const rows = [...unique.values()].map((position) => ({
      chain_id: position.chainId.toString(),
      dex: position.dex,
      token_id: position.tokenId.toString(),
      owner: hexBytes(position.owner),
      pool_ref: position.poolRef,
      currency0: hexBytes(position.currency0),
      currency1: hexBytes(position.currency1),
      fee: position.fee,
      tick_spacing: position.tickSpacing,
      hooks: hexBytes(position.hooks),
      tick_lower: position.tickLower,
      tick_upper: position.tickUpper,
      liquidity: position.liquidity.toString(),
      status: position.status,
      opened_block: position.openedBlock.toString(),
      updated_block: position.updatedBlock.toString(),
      updated_block_hash: hexBytes(position.updatedBlockHash),
    }));
    for (const batch of insertBatches(rows, 18)) {
      await this.#sql`
        INSERT INTO positions ${this.#sql(batch, "chain_id", "dex", "token_id", "owner", "pool_ref",
          "currency0", "currency1", "fee", "tick_spacing", "hooks", "tick_lower", "tick_upper",
          "liquidity", "status", "opened_block", "updated_block", "updated_block_hash")}
        ON CONFLICT (chain_id, dex, token_id) DO UPDATE SET
          owner = EXCLUDED.owner, pool_ref = EXCLUDED.pool_ref,
          currency0 = EXCLUDED.currency0, currency1 = EXCLUDED.currency1,
          fee = EXCLUDED.fee, tick_spacing = EXCLUDED.tick_spacing, hooks = EXCLUDED.hooks,
          tick_lower = EXCLUDED.tick_lower, tick_upper = EXCLUDED.tick_upper,
          liquidity = EXCLUDED.liquidity, status = EXCLUDED.status,
          updated_block = EXCLUDED.updated_block, updated_block_hash = EXCLUDED.updated_block_hash,
          range_state = CASE WHEN EXCLUDED.liquidity = 0 THEN 'UNKNOWN' ELSE positions.range_state END,
          out_streak = CASE WHEN EXCLUDED.liquidity = 0 THEN 0 ELSE positions.out_streak END,
          in_streak = CASE WHEN EXCLUDED.liquidity = 0 THEN 0 ELSE positions.in_streak END,
          updated_at = now()
      `;
    }
  }

  async findPositionsByOwner(chainId: bigint, owner: Address): Promise<PositionRecord[]> {
    const rows = await this.#sql`
      SELECT * FROM positions
      WHERE chain_id = ${chainId.toString()} AND owner = ${hexBytes(owner)}
      ORDER BY dex, token_id
    `;
    return rows.map((row) => positionRow(row));
  }

  /** Position rows keyed by `${dex}:${tokenId}`, independent of their current owner. */
  async findPositionsByTokens(
    chainId: bigint,
    entries: readonly { dex: Dex; tokenId: bigint }[],
  ): Promise<Map<string, PositionRecord>> {
    const byDex = new Map<Dex, Set<string>>();
    for (const entry of entries) {
      let tokenIds = byDex.get(entry.dex);
      if (tokenIds === undefined) {
        tokenIds = new Set();
        byDex.set(entry.dex, tokenIds);
      }
      tokenIds.add(entry.tokenId.toString());
    }

    const positions = new Map<string, PositionRecord>();
    for (const [dex, tokenIds] of byDex) {
      if (tokenIds.size === 0) continue;
      const rows = await this.#sql`
        SELECT * FROM positions
        WHERE chain_id = ${chainId.toString()} AND dex = ${dex}
          AND token_id IN ${this.#sql([...tokenIds])}
      `;
      for (const row of rows) {
        const position = positionRow(row);
        positions.set(`${position.dex}:${position.tokenId}`, position);
      }
    }
    return positions;
  }

  /**
   * Every ACTIVE position on this chain whose current owner has at least one
   * active subscriber. Subscriptions are chain-agnostic: the same chat watches
   * the address on every enabled chain.
   */
  async monitoredPositions(chainId: bigint): Promise<PositionRecord[]> {
    const rows = await this.#sql`
      SELECT p.* FROM positions p
      WHERE p.chain_id = ${chainId.toString()} AND p.status = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.status = 'ACTIVE' AND s.watched_address = p.owner
        )
      ORDER BY p.dex, p.pool_ref, p.token_id
    `;
    return rows.map((row) => positionRow(row));
  }

  async countPositionsByOwner(chainId: bigint, owner: Address): Promise<number> {
    const rows = await this.#sql`
      SELECT count(*)::int AS count FROM positions
      WHERE chain_id = ${chainId.toString()} AND owner = ${hexBytes(owner)} AND status = 'ACTIVE'
    `;
    return asNumber(rows[0]?.count ?? 0);
  }

  async countActivePositions(chainId: bigint): Promise<number> {
    const rows = await this.#sql`
      SELECT count(*)::int AS count FROM positions
      WHERE chain_id = ${chainId.toString()} AND status = 'ACTIVE'
    `;
    return asNumber(rows[0]?.count ?? 0);
  }

  // --- position owners (per-chain ERC-721 transfer index) ------------------

  async upsertPositionOwners(chainId: bigint, rows: readonly {
    dex: Dex; tokenId: bigint; owner: Address; mintedBlock: bigint; updatedBlock: bigint; blockHash: Hex;
  }[]): Promise<void> {
    if (rows.length === 0) return;
    // A chunk can contain several transfers of the same token id. Keep the
    // newest event so the bulk upsert has one row per key.
    const unique = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const key = `${row.dex}:${row.tokenId}`;
      const previous = unique.get(key);
      if (previous === undefined || previous.updatedBlock <= row.updatedBlock) unique.set(key, row);
    }
    const values = [...unique.values()].map((row) => ({
      chain_id: chainId.toString(),
      dex: row.dex,
      token_id: row.tokenId.toString(),
      owner: hexBytes(row.owner),
      minted_block: row.mintedBlock.toString(),
      updated_block: row.updatedBlock.toString(),
      updated_block_hash: hexBytes(row.blockHash),
    }));
    for (const batch of insertBatches(values, 7)) {
      await this.#sql`
        INSERT INTO position_owners ${this.#sql(batch, "chain_id", "dex", "token_id", "owner",
          "minted_block", "updated_block", "updated_block_hash")}
        ON CONFLICT (chain_id, dex, token_id) DO UPDATE SET
          owner = EXCLUDED.owner, updated_block = EXCLUDED.updated_block,
          updated_block_hash = EXCLUDED.updated_block_hash
        WHERE position_owners.updated_block <= EXCLUDED.updated_block
      `;
    }
  }

  async tokenIdsByOwner(chainId: bigint, owner: Address): Promise<{ dex: Dex; tokenId: bigint }[]> {
    const rows = await this.#sql`
      SELECT dex, token_id FROM position_owners
      WHERE chain_id = ${chainId.toString()} AND owner = ${hexBytes(owner)}
      ORDER BY dex, token_id
    `;
    return rows.map((row) => ({ dex: String(row.dex) as Dex, tokenId: asBigInt(row.token_id) }));
  }

  async ownersForTokens(chainId: bigint, dex: Dex, tokenIds: readonly bigint[]): Promise<Map<string, Address>> {
    if (tokenIds.length === 0) return new Map();
    const rows = await this.#sql`
      SELECT token_id, owner FROM position_owners
      WHERE chain_id = ${chainId.toString()} AND dex = ${dex}
        AND token_id IN ${this.#sql(tokenIds.map((value) => value.toString()))}
    `;
    const owners = new Map<string, Address>();
    for (const row of rows) owners.set(String(asBigInt(row.token_id)), getAddress(bytesHex(row.owner as Uint8Array)));
    return owners;
  }

  async deletePositionOwners(chainId: bigint, dex: Dex, tokenIds: readonly bigint[]): Promise<void> {
    if (tokenIds.length === 0) return;
    await this.#sql`
      DELETE FROM position_owners
      WHERE chain_id = ${chainId.toString()} AND dex = ${dex}
        AND token_id IN ${this.#sql(tokenIds.map((value) => value.toString()))}
    `;
  }

  /**
   * Keeps materialized positions consistent with the ERC-721 ownership index:
   * a transfer reassigns the row to the new owner (so the previous owner stops
   * being monitored even when the new owner is not subscribed), and a burn
   * (`to = 0x0`) closes it with zero liquidity, matching the DB CHECK.
   */
  async syncPositionOwnership(
    chainId: bigint,
    dex: Dex,
    reassignedTokenIds: readonly bigint[],
    burnedTokenIds: readonly bigint[],
    blockNumber: bigint,
    blockHash: Hex,
  ): Promise<void> {
    if (reassignedTokenIds.length > 0) {
      await this.#sql`
        UPDATE positions p
        SET owner = po.owner, updated_block = ${blockNumber.toString()},
            updated_block_hash = ${hexBytes(blockHash)}, updated_at = now()
        FROM position_owners po
        WHERE p.chain_id = ${chainId.toString()} AND p.dex = ${dex}
          AND po.chain_id = p.chain_id AND po.dex = p.dex
          AND p.token_id = po.token_id
          AND p.token_id IN ${this.#sql(reassignedTokenIds.map((value) => value.toString()))}
      `;
    }
    if (burnedTokenIds.length > 0) {
      await this.#sql`
        UPDATE positions
        SET status = 'CLOSED', liquidity = 0, range_state = 'UNKNOWN',
            out_streak = 0, in_streak = 0,
            updated_block = ${blockNumber.toString()},
            updated_block_hash = ${hexBytes(blockHash)}, updated_at = now()
        WHERE chain_id = ${chainId.toString()} AND dex = ${dex}
          AND token_id IN ${this.#sql(burnedTokenIds.map((value) => value.toString()))}
      `;
    }
  }

  // --- position events -----------------------------------------------------

  async insertPositionEvents(events: readonly PositionEventRow[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((event) => ({
      chain_id: event.chainId.toString(),
      dex: event.dex,
      kind: event.kind,
      block_number: event.blockNumber.toString(),
      block_hash: hexBytes(event.blockHash),
      transaction_hash: hexBytes(event.transactionHash),
      log_index: event.logIndex,
      token_id: event.tokenId === null ? null : event.tokenId.toString(),
      pool_ref: event.poolRef,
      owner: event.owner === null ? null : hexBytes(event.owner),
      tick_lower: event.tickLower,
      tick_upper: event.tickUpper,
      liquidity_delta: event.liquidityDelta === null ? null : event.liquidityDelta.toString(),
    }));
    for (const batch of insertBatches(rows, 13)) {
      await this.#sql`
        INSERT INTO position_events ${this.#sql(batch, "chain_id", "dex", "kind", "block_number",
          "block_hash", "transaction_hash", "log_index", "token_id", "pool_ref", "owner",
          "tick_lower", "tick_upper", "liquidity_delta")}
        ON CONFLICT (chain_id, dex, block_number, log_index) DO NOTHING
      `;
    }
  }

  // --- incidents + outbox --------------------------------------------------

  /**
   * Writes the incidents and their delivery fan-out in one transaction: an
   * incident and its outbox rows commit together, so a crash cannot leave an
   * incident with no delivery or a delivery with no incident. The fan-out is
   * computed from the live subscriptions inside the same transaction.
   */
  async recordRound(chainId: bigint, updates: readonly RangeUpdate[], incidents: readonly IncidentRecord[]): Promise<number> {
    return this.#sql.begin(async (tx) => {
      for (const update of updates) {
        await tx`
          UPDATE positions SET range_state = ${update.rangeState}, out_streak = ${update.outStreak},
            in_streak = ${update.inStreak}, state_version = ${update.stateVersion},
            last_eval_block = ${update.lastEvalBlock.toString()}, updated_at = now()
          WHERE chain_id = ${chainId.toString()} AND dex = ${update.dex} AND token_id = ${update.tokenId.toString()}
        `;
      }
      let created = 0;
      for (const incident of incidents) {
        const inserted = await tx`
          INSERT INTO incidents (chain_id, idempotency_key, type, dex, pool_ref, token_id, owner,
            from_state, to_state, state_version, block_number, block_hash, payload)
          VALUES (${incident.chainId.toString()}, ${incident.idempotencyKey}, ${incident.type}, ${incident.dex},
            ${incident.poolRef}, ${incident.tokenId === null ? null : incident.tokenId.toString()},
            ${incident.owner === null ? null : hexBytes(incident.owner)}, ${incident.fromState}, ${incident.toState},
            ${incident.stateVersion}, ${incident.blockNumber.toString()},
            ${hexBytes(incident.blockHash)}, ${tx.json(incident.payload as never)})
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `;
        const id = inserted[0]?.id;
        if (id === undefined) continue;
        created += 1;
        if (incident.owner !== null) {
          await tx`
            INSERT INTO deliveries (incident_id, subscription_id, telegram_chat_id)
            SELECT ${id}, s.id, s.telegram_chat_id FROM subscriptions s
            WHERE s.status = 'ACTIVE' AND s.watched_address = ${hexBytes(incident.owner)}
            ON CONFLICT (incident_id, subscription_id) DO NOTHING
          `;
        }
      }
      return created;
    });
  }

  async claimDueDeliveries(limit: number): Promise<DueDelivery[]> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx`
        SELECT d.id, d.incident_id, d.telegram_chat_id, d.attempts, d.subscription_id,
               i.type, i.payload, s.nickname
        FROM deliveries d
        JOIN incidents i ON i.id = d.incident_id
        JOIN subscriptions s ON s.id = d.subscription_id
        WHERE (d.status = 'QUEUED'
               OR (d.status = 'RETRY_WAIT' AND d.next_retry_at <= now())
               -- a crashed worker leaves rows in SENDING; reclaim them
               OR (d.status = 'SENDING' AND d.updated_at < now() - interval '5 minutes'))
          AND s.status = 'ACTIVE'
        ORDER BY d.next_retry_at NULLS FIRST, d.id
        LIMIT ${limit}
        FOR UPDATE OF d SKIP LOCKED
      `;
      const claimed: DueDelivery[] = [];
      for (const row of rows) {
        await tx`UPDATE deliveries SET status = 'SENDING', updated_at = now() WHERE id = ${row.id}`;
        claimed.push({
          id: String(row.id),
          incidentId: String(row.incident_id),
          telegramChatId: String(row.telegram_chat_id),
          attempts: asNumber(row.attempts),
          type: String(row.type) as IncidentRecord["type"],
          payload: row.payload as Record<string, unknown>,
          subscriptionId: String(row.subscription_id),
          nickname: row.nickname === null || row.nickname === undefined ? null : String(row.nickname),
        });
      }
      return claimed;
    });
  }

  async markDelivered(id: string, telegramMessageId: bigint | null): Promise<void> {
    await this.#sql`
      UPDATE deliveries SET status = 'DELIVERED', attempts = attempts + 1,
        telegram_message_id = ${telegramMessageId === null ? null : telegramMessageId.toString()},
        error_class = NULL, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async markRetry(id: string, nextRetryAt: Date, errorClass: string): Promise<void> {
    await this.#sql`
      UPDATE deliveries SET status = 'RETRY_WAIT', attempts = attempts + 1,
        next_retry_at = ${nextRetryAt}, error_class = ${errorClass}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async markFailedFinal(id: string, errorClass: string): Promise<void> {
    await this.#sql`
      UPDATE deliveries SET status = 'FAILED_FINAL', attempts = attempts + 1,
        error_class = ${errorClass}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async deliveryStatusCounts(): Promise<Record<DeliveryStatus, number>> {
    const rows = await this.#sql`
      SELECT status, count(*)::int AS count FROM deliveries GROUP BY status
    `;
    const counts: Record<DeliveryStatus, number> = {
      QUEUED: 0, SENDING: 0, DELIVERED: 0, RETRY_WAIT: 0, FAILED_FINAL: 0,
    };
    for (const row of rows) counts[String(row.status) as DeliveryStatus] = asNumber(row.count);
    return counts;
  }

  // --- subscriptions -------------------------------------------------------

  /** Returns true when a new subscription was created, false when one already existed. */
  async createSubscription(chatId: string, address: Address, nickname: string | null = null): Promise<boolean> {
    const rows = await this.#sql`
      INSERT INTO subscriptions (telegram_chat_id, watched_address, nickname)
      VALUES (${chatId}, ${hexBytes(address)}, ${nickname})
      ON CONFLICT (telegram_chat_id, watched_address) WHERE status = 'ACTIVE' DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }

  async findActiveSubscription(chatId: string, address: Address): Promise<{ id: string; nickname: string | null } | null> {
    const rows = await this.#sql`
      SELECT id, nickname FROM subscriptions
      WHERE telegram_chat_id = ${chatId} AND watched_address = ${hexBytes(address)} AND status = 'ACTIVE'
      LIMIT 1
    `;
    const row = rows[0];
    return row ? { id: String(row.id), nickname: row.nickname === null || row.nickname === undefined ? null : String(row.nickname) } : null;
  }

  async listSubscriptions(chatId: string): Promise<SubscriptionRow[]> {
    const rows = await this.#sql`
      SELECT id, telegram_chat_id, watched_address, nickname, status FROM subscriptions
      WHERE telegram_chat_id = ${chatId} AND status = 'ACTIVE'
      ORDER BY created_at, id
    `;
    return rows.map((row) => ({
      id: String(row.id),
      telegramChatId: String(row.telegram_chat_id),
      watchedAddress: getAddress(bytesHex(row.watched_address as Uint8Array)),
      nickname: row.nickname === null || row.nickname === undefined ? null : String(row.nickname),
      status: String(row.status) as SubscriptionRow["status"],
    }));
  }

  async countActiveSubscriptions(chatId: string): Promise<number> {
    const rows = await this.#sql`
      SELECT count(*)::int AS count FROM subscriptions
      WHERE telegram_chat_id = ${chatId} AND status = 'ACTIVE'
    `;
    return asNumber(rows[0]?.count ?? 0);
  }

  async revokeSubscription(chatId: string, address: Address): Promise<boolean> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE subscriptions SET status = 'REVOKED', updated_at = now()
        WHERE telegram_chat_id = ${chatId}
          AND watched_address = ${hexBytes(address)} AND status = 'ACTIVE'
        RETURNING id
      `;
      if (rows.length === 0) return false;
      // A revoked subscription must not receive alerts queued before the command.
      for (const row of rows) {
        await tx`
          UPDATE deliveries SET status = 'FAILED_FINAL', error_class = 'SUBSCRIPTION_REVOKED', updated_at = now()
          WHERE subscription_id = ${row.id} AND status IN ('QUEUED','RETRY_WAIT')
        `;
      }
      return true;
    });
  }

  /** Watched owner addresses (distinct, all chains). */
  async watchedAddresses(): Promise<Address[]> {
    const rows = await this.#sql`
      SELECT DISTINCT watched_address FROM subscriptions WHERE status = 'ACTIVE'
    `;
    return rows.map((row) => getAddress(bytesHex(row.watched_address as Uint8Array)));
  }

  // --- token metadata ------------------------------------------------------

  async getTokenMetadata(chainId: bigint, addresses: readonly Address[]): Promise<Map<string, TokenInfo>> {
    if (addresses.length === 0) return new Map();
    const rows = await this.#sql`
      SELECT address, symbol, decimals FROM tokens
      WHERE chain_id = ${chainId.toString()}
        AND address IN ${this.#sql(addresses.map((address) => hexBytes(address)))}
    `;
    const metadata = new Map<string, TokenInfo>();
    for (const row of rows) {
      metadata.set(bytesHex(row.address as Uint8Array).toLowerCase(), {
        symbol: String(row.symbol),
        decimals: asNumber(row.decimals),
      });
    }
    return metadata;
  }

  async upsertTokenMetadata(chainId: bigint, rows: readonly { address: Address; symbol: string; decimals: number }[]): Promise<void> {
    if (rows.length === 0) return;
    const unique = new Map<string, typeof rows[number]>();
    for (const row of rows) unique.set(row.address.toLowerCase(), row);
    const values = [...unique.values()].map((row) => ({
      chain_id: chainId.toString(),
      address: hexBytes(row.address),
      symbol: row.symbol,
      decimals: row.decimals,
    }));
    for (const batch of insertBatches(values, 4)) {
      await this.#sql`
        INSERT INTO tokens ${this.#sql(batch, "chain_id", "address", "symbol", "decimals")}
        ON CONFLICT (chain_id, address) DO UPDATE SET
          symbol = EXCLUDED.symbol, decimals = EXCLUDED.decimals, updated_at = now()
      `;
    }
  }

  // --- telegram updates ----------------------------------------------------

  /** Returns true when this update_id is new; false when it is a replay. */
  async recordTelegramUpdate(updateId: bigint, chatId: string, kind: string): Promise<boolean> {
    const rows = await this.#sql`
      INSERT INTO telegram_updates (update_id, telegram_chat_id, kind)
      VALUES (${updateId.toString()}, ${chatId}, ${kind})
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id
    `;
    return rows.length > 0;
  }
}
