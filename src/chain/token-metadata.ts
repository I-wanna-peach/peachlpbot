import type { Address } from "viem";
import { erc20MetadataAbi } from "../abi.js";
import type { ChainDescriptor } from "../chains.js";
import type { Store } from "../db/store.js";
import type { ChainClient, MulticallResult } from "../rpc.js";
import type { TokenInfo } from "../types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOKENS_PER_MULTICALL = 100;

function unwrap<T>(result: MulticallResult<unknown> | undefined): T | null {
  return result && result.success ? (result.result as T) : null;
}

/**
 * Symbol/decimals cache used only for human-readable pricing. A token without a
 * readable `decimals()` is deliberately left unresolved: a price computed from a
 * guessed decimal count is worse than showing ticks only.
 *
 * The zero address is the chain's native asset (BNB on BSC, USDC on Arc) and is
 * resolved locally, never through an eth_call.
 */
export class TokenMetadataCache {
  readonly #store: Store;
  readonly #client: ChainClient;
  readonly #chain: ChainDescriptor;
  readonly #cache = new Map<string, TokenInfo>();

  constructor(deps: { store: Store; client: ChainClient; chain: ChainDescriptor }) {
    this.#store = deps.store;
    this.#client = deps.client;
    this.#chain = deps.chain;
  }

  async get(addresses: readonly Address[]): Promise<Map<string, TokenInfo>> {
    const resolved = new Map<string, TokenInfo>();
    const missing: Address[] = [];
    for (const address of addresses) {
      const key = address.toLowerCase();
      if (resolved.has(key)) continue;
      if (key === ZERO_ADDRESS) {
        resolved.set(key, { symbol: this.#chain.nativeSymbol, decimals: 18 });
        continue;
      }
      const cached = this.#cache.get(key);
      if (cached !== undefined) {
        resolved.set(key, cached);
        continue;
      }
      missing.push(address);
    }
    if (missing.length === 0) return resolved;

    const stored = await this.#store.getTokenMetadata(this.#chain.chainId, missing);
    const toFetch: Address[] = [];
    for (const address of missing) {
      const key = address.toLowerCase();
      const info = stored.get(key);
      if (info !== undefined) {
        this.#cache.set(key, info);
        resolved.set(key, info);
      } else {
        toFetch.push(address);
      }
    }
    if (toFetch.length === 0) return resolved;

    const block = await this.#client.getBlockNumber();
    const rows: { address: Address; symbol: string; decimals: number }[] = [];
    for (let offset = 0; offset < toFetch.length; offset += TOKENS_PER_MULTICALL) {
      const batch = toFetch.slice(offset, offset + TOKENS_PER_MULTICALL);
      const calls = [];
      for (const address of batch) {
        calls.push({ address, abi: erc20MetadataAbi, functionName: "symbol" as const, args: [] });
        calls.push({ address, abi: erc20MetadataAbi, functionName: "decimals" as const, args: [] });
      }
      const results = await this.#client.multicallSafe<unknown>(calls, block);
      batch.forEach((address, index) => {
        const symbol = unwrap<string>(results[index * 2]);
        const decimals = unwrap<number>(results[index * 2 + 1]);
        if (decimals === null) return;
        const value = Number(decimals);
        if (!Number.isInteger(value) || value < 0 || value > 255) return;
        const info: TokenInfo = {
          symbol: symbol === null || String(symbol).length === 0
            ? `${address.slice(0, 6)}…${address.slice(-4)}`
            : String(symbol),
          decimals: value,
        };
        this.#cache.set(address.toLowerCase(), info);
        resolved.set(address.toLowerCase(), info);
        rows.push({ address, ...info });
      });
    }
    await this.#store.upsertTokenMetadata(this.#chain.chainId, rows);
    return resolved;
  }
}
