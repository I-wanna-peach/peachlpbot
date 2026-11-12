import { describe, expect, test } from "bun:test";
import { getAddress, type Hex } from "viem";
import type { Store } from "../src/db/store.js";
import type { ChainClient, MulticallContract, MulticallResult } from "../src/rpc.js";
import type { TokenMetadataCache } from "../src/chain/token-metadata.js";
import type { ChainConfig } from "../src/config.js";
import { BSC } from "../src/chains.js";
import { TickMonitor } from "../src/monitor/tick-monitor.js";
import type { PositionRecord } from "../src/types.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN0 = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN1 = getAddress("0x3333333333333333333333333333333333333333");
const HASH = `0x${"ab".repeat(32)}` as Hex;

function poolRef(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function position(index: number): PositionRecord {
  return {
    chainId: 56n,
    dex: "UNISWAP_V4",
    tokenId: BigInt(index),
    owner: OWNER,
    poolRef: poolRef(index),
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 3000,
    tickSpacing: 60,
    hooks: getAddress("0x0000000000000000000000000000000000000000"),
    tickLower: -100,
    tickUpper: 100,
    liquidity: 1_000n,
    status: "ACTIVE",
    rangeState: "IN_RANGE",
    outStreak: 0,
    inStreak: 3,
    stateVersion: 0,
    lastEvalBlock: 0n,
    openedBlock: 1n,
    updatedBlock: 1n,
    updatedBlockHash: HASH,
  };
}

const config: ChainConfig = {
  descriptor: BSC,
  rpcUrl: "http://127.0.0.1:8545",
  pollIntervalMs: 5_000,
  indexer: {
    startBlock: null,
    lookbackBlocks: 0n,
    chunkSize: 10_000n,
    reorgRewind: 128n,
    maxChunksPerRun: 1,
    tailWindowBlocks: 20_000n,
  },
};

describe("TickMonitor multicall batching", () => {
  test("150 pools are split into batches of at most 100 pools", async () => {
    const positions = Array.from({ length: 150 }, (_, index) => position(index + 1));
    const batchSizes: number[] = [];

    const store = {
      monitoredPositions: async () => positions,
      updatePoolTicks: async () => {},
      recordRound: async () => 0,
    } as unknown as Store;

    const metadata = new Map([
      [TOKEN0.toLowerCase(), { symbol: "AAA", decimals: 18 }],
      [TOKEN1.toLowerCase(), { symbol: "BBB", decimals: 18 }],
    ]);
    const tokens = { get: async () => metadata } as unknown as TokenMetadataCache;

    const client = {
      chainId: 56n,
      getBlockNumber: async () => 1_000n,
      getBlock: async () => ({ number: 1_000n, hash: HASH, parentHash: HASH, timestamp: 0n }),
      multicallSafe: async (calls: readonly MulticallContract[]): Promise<MulticallResult<unknown>[]> => {
        batchSizes.push(calls.length);
        return calls.map((_, index) => index % 2 === 0
          ? { success: true, result: [1n << 96n, 0, 0, 0] }
          : { success: true, result: 1n });
      },
    } as unknown as ChainClient;

    const monitor = new TickMonitor({
      client,
      store,
      chain: BSC,
      config: { outOfRangeConfirmBlocks: 2, inRangeConfirmBlocks: 3, notifyBackInRange: false, rulesVersion: "1" },
      tokens,
    });

    const result = await monitor.runOnce();
    expect(result.poolsRead).toBe(150);
    expect(batchSizes).toEqual([200, 100]);
    expect(batchSizes.every((size) => size <= 200)).toBe(true);
    expect(config.descriptor.chainId).toBe(56n);
  });
});
