/**
 * Environment configuration, loaded in sections so that a process only fails on
 * the variables it actually uses (an indexer-only run must not require the
 * Telegram token, and vice versa).
 */

import { CHAIN_BY_KEY, type ChainDescriptor } from "./chains.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value ? value : null;
}

function positiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name];
  if ((raw === undefined || raw === "") && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function bigintEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = BigInt(raw);
  if (value < 0n) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

/** `<KEY>_<NAME>` wins over the global `<NAME>`, which wins over the descriptor default. */
function chainEnv(key: string, name: string): string | null {
  return optional(`${key.toUpperCase()}_${name}`) ?? optional(name);
}

function chainBigInt(key: string, name: string, fallback: bigint): bigint {
  const raw = chainEnv(key, name);
  if (raw === null || raw === "") return fallback;
  const value = BigInt(raw);
  if (value < 0n) throw new Error(`${name} for ${key} must be a non-negative integer.`);
  return value;
}

function chainInteger(key: string, name: string, fallback: number): number {
  const raw = chainEnv(key, name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} for ${key} must be a non-negative integer.`);
  return value;
}

export interface DatabaseConfig {
  url: string;
  socketPath: string | null;
}

export function loadDatabaseConfig(): DatabaseConfig {
  return { url: required("DATABASE_URL"), socketPath: optional("DATABASE_SOCKET_PATH") };
}

export interface IndexerConfig {
  /**
   * Explicit first block. `null` means "derive it from `lookbackBlocks` at the
   * first run", which is the cost-bounded default: positions older than the
   * window are deliberately not backfilled.
   */
  startBlock: bigint | null;
  lookbackBlocks: bigint;
  chunkSize: bigint;
  reorgRewind: bigint;
  maxChunksPerRun: number;
  /** Chunks this close to head also pull liquidity events, not just transfers. */
  tailWindowBlocks: bigint;
}

export interface ChainConfig {
  descriptor: ChainDescriptor;
  rpcUrl: string;
  indexer: IndexerConfig;
  pollIntervalMs: number;
}

/**
 * Builds one resolved runtime config per entry in `CHAINS` (default `bsc,arc`).
 * The RPC URL is the only per-chain variable that is mandatory: the endpoints
 * are IP-whitelisted, so a missing URL is a real configuration error.
 */
export function loadChainConfigs(): ChainConfig[] {
  const raw = optional("CHAINS") ?? "bsc,arc";
  const keys = raw.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
  if (keys.length === 0) throw new Error("CHAINS must list at least one chain (bsc, arc).");

  const seen = new Set<string>();
  const configs: ChainConfig[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const descriptor = CHAIN_BY_KEY.get(key);
    if (descriptor === undefined) throw new Error(`Unknown chain "${key}" in CHAINS; expected bsc or arc.`);

    const rpcUrl = required(`${key.toUpperCase()}_RPC_URL`);
    const startBlockRaw = chainEnv(key, "INDEXER_START_BLOCK");
    configs.push({
      descriptor,
      rpcUrl,
      indexer: {
        startBlock: startBlockRaw === null || startBlockRaw === "" ? null : chainBigInt(key, "INDEXER_START_BLOCK", 0n),
        lookbackBlocks: chainBigInt(key, "LOOKBACK_BLOCKS", descriptor.defaults.lookbackBlocks),
        chunkSize: chainBigInt(key, "LOG_CHUNK_SIZE", descriptor.defaults.logChunkSize),
        reorgRewind: chainBigInt(key, "REORG_REWIND", descriptor.defaults.reorgRewind),
        maxChunksPerRun: chainInteger(key, "MAX_CHUNKS_PER_RUN", descriptor.defaults.maxChunksPerRun),
        tailWindowBlocks: chainBigInt(key, "TAIL_WINDOW_BLOCKS", descriptor.defaults.tailWindowBlocks),
      },
      pollIntervalMs: chainInteger(key, "POLL_INTERVAL_MS", descriptor.defaults.pollIntervalMs),
    });
  }
  return configs;
}

export interface TelegramConfig {
  botToken: string;
  maxSubscriptionsPerChat: number;
  communityGroupUrl: string | null;
  communityXUrl: string | null;
}

export function loadTelegramConfig(): TelegramConfig {
  return {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    maxSubscriptionsPerChat: positiveInteger("MAX_SUBSCRIPTIONS_PER_CHAT", 20),
    communityGroupUrl: optional("COMMUNITY_GROUP_URL"),
    communityXUrl: optional("COMMUNITY_X_URL"),
  };
}

export interface MonitorConfig {
  outOfRangeConfirmBlocks: number;
  inRangeConfirmBlocks: number;
  notifyBackInRange: boolean;
  rulesVersion: string;
}

export function loadMonitorConfig(): MonitorConfig {
  const outOfRangeConfirmBlocks = positiveInteger("OUT_OF_RANGE_CONFIRM_BLOCKS", 2);
  const inRangeConfirmBlocks = positiveInteger("IN_RANGE_CONFIRM_BLOCKS", 3);
  if (outOfRangeConfirmBlocks < 1 || inRangeConfirmBlocks < 1) {
    throw new Error("Confirmation block counts must be at least 1.");
  }
  const backInFlag = (process.env.NOTIFY_BACK_IN_RANGE ?? "").toLowerCase();
  return {
    outOfRangeConfirmBlocks,
    inRangeConfirmBlocks,
    notifyBackInRange: backInFlag === "true" || backInFlag === "1",
    rulesVersion: process.env.ALERT_RULES_VERSION ?? "1",
  };
}
