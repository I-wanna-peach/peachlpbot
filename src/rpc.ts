import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { ChainDescriptor } from "./chains.js";
import type { ChainBlock, ChainLog } from "./types.js";

export interface MulticallContract {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export interface ChainClient {
  readonly chainId: bigint;
  readonly descriptor: ChainDescriptor;
  getChainId(): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<ChainBlock>;
  /** Inclusive `[fromBlock, toBlock]`, chunked and flattened. */
  getLogs(input: {
    address?: Address | Address[];
    topics?: readonly (Hex | readonly Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ChainLog[]>;
  /** One `eth_getLogs` for the exact range; used by the probe to measure limits. */
  getLogsOnce(input: {
    address?: Address | Address[];
    topics?: readonly (Hex | readonly Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ChainLog[]>;
  multicall<T>(contracts: readonly MulticallContract[], blockNumber: bigint): Promise<T[]>;
  multicallSafe<T>(contracts: readonly MulticallContract[], blockNumber: bigint): Promise<MulticallResult<T>[]>;
  call(input: { to: Address; data: Hex; blockNumber?: bigint }): Promise<Hex>;
  getCode(address: Address): Promise<Hex>;
}

export type MulticallResult<T> = { success: true; result: T } | { success: false; reason: string };

interface RawLog {
  address: Address;
  blockHash: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  data: Hex;
  topics: readonly Hex[];
}

function toChainLog(log: RawLog): ChainLog {
  return {
    address: getAddress(log.address),
    blockHash: log.blockHash,
    blockNumber: BigInt(log.blockNumber),
    transactionHash: log.transactionHash,
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    data: log.data,
    topics: log.topics,
  };
}

export function createChainClient(input: {
  chain: ChainDescriptor;
  rpcUrl: string;
  chunkSize: bigint;
}): ChainClient {
  const client: PublicClient = createPublicClient({
    chain: input.chain.viemChain,
    // The v4 PoolManager ModifyLiquidity stream can exceed viem's 10 MB default
    // for a large chunk. 64 MB matches the node-side market profile's cap.
    transport: http(input.rpcUrl, {
      timeout: 30_000,
      retryCount: 2,
      retryDelay: 250,
      maxResponseBodySize: 64 * 1024 * 1024,
    }),
    batch: { multicall: true },
  });
  const chunkSize = input.chunkSize > 0n ? input.chunkSize : 10_000n;

  async function fetchLogs(query: {
    address?: Address | Address[];
    topics?: readonly (Hex | readonly Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ChainLog[]> {
    if (query.fromBlock > query.toBlock) return [];
    // viem's typed `getLogs` action does not accept a raw `topics` array -- it
    // silently serialises it as `[]` (it builds topics from event/args). Send
    // the raw eth_getLogs request so the topic filter actually applies.
    const page = await client.request({
      method: "eth_getLogs",
      params: [{
        ...(query.address === undefined ? {} : { address: query.address }),
        ...(query.topics === undefined ? {} : { topics: query.topics }),
        fromBlock: `0x${query.fromBlock.toString(16)}`,
        toBlock: `0x${query.toBlock.toString(16)}`,
      }],
    } as never) as RawLog[];
    return page.map(toChainLog);
  }

  return {
    chainId: input.chain.chainId,
    descriptor: input.chain,

    async getChainId(): Promise<bigint> {
      return BigInt(await client.getChainId());
    },

    async getBlockNumber(): Promise<bigint> {
      return client.getBlockNumber();
    },

    async getBlock(blockNumber: bigint): Promise<ChainBlock> {
      const block = await client.getBlock({ blockNumber, includeTransactions: false });
      return {
        number: block.number,
        hash: block.hash as Hex,
        parentHash: block.parentHash as Hex,
        timestamp: block.timestamp,
      };
    },

    async getLogs({ address, topics, fromBlock, toBlock }): Promise<ChainLog[]> {
      if (fromBlock > toBlock) return [];
      const logs: ChainLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
        logs.push(...await fetchLogs({ ...(address === undefined ? {} : { address }), ...(topics === undefined ? {} : { topics }), fromBlock: start, toBlock: end }));
      }
      logs.sort((left, right) => (
        left.blockNumber === right.blockNumber
          ? left.logIndex - right.logIndex
          : Number(left.blockNumber - right.blockNumber)
      ));
      return logs;
    },

    async getLogsOnce(query): Promise<ChainLog[]> {
      return fetchLogs(query);
    },

    async multicall<T>(contracts: readonly MulticallContract[], blockNumber: bigint): Promise<T[]> {
      const results = await client.multicall({ contracts: contracts as never, blockNumber, allowFailure: false });
      return results as T[];
    },

    async multicallSafe<T>(contracts: readonly MulticallContract[], blockNumber: bigint): Promise<MulticallResult<T>[]> {
      const results = await client.multicall({ contracts: contracts as never, blockNumber, allowFailure: true });
      return (results as readonly { status: string; result?: unknown; error?: unknown }[]).map((entry) => (
        entry.status === "success"
          ? { success: true, result: entry.result as T }
          : { success: false, reason: entry.error instanceof Error ? entry.error.message : String(entry.error) }
      ));
    },

    async call({ to, data, blockNumber }): Promise<Hex> {
      const result = await client.call(blockNumber === undefined ? { to, data } : { to, data, blockNumber });
      if (result.data === undefined) throw new Error(`eth_call to ${to} returned no data.`);
      return result.data;
    },

    async getCode(address: Address): Promise<Hex> {
      return (await client.getCode({ address })) ?? "0x";
    },
  };
}
