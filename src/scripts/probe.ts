import { parseAbi, toEventSelector, type Address } from "viem";
import { loadChainConfigs, type ChainConfig } from "../config.js";
import { createChainClient, type ChainClient, type MulticallResult } from "../rpc.js";
import {
  erc721EnumerableAbi,
  erc721TransferEvent,
  v3FactoryAbi,
  v3PoolAbi,
  v3PositionManagerAbi,
  v4PositionManagerAbi,
  v4StateViewAbi,
} from "../abi.js";
import type { ChainDescriptor } from "../chains.js";
import { decodeV3Position } from "../indexer/v3-layout.js";
import { computeV4PoolId, decodePositionTicks } from "../indexer/refresh.js";
import { safeError } from "../util.js";

/**
 * Read-only deployment probe. Run it ON the whitelisted host:
 *
 *   bun run probe
 *
 * It verifies chain identity, contract code, ERC721Enumerable behaviour, the
 * `positions()` layout, v4 reads, Multicall3, and measures the largest accepted
 * `eth_getLogs` range so the per-chain chunk size can be set from evidence.
 */

const TRANSFER_SELECTOR = toEventSelector(erc721TransferEvent);
const multicall3Abi = parseAbi(["function getChainId() view returns (uint256)"]);

function unwrap<T>(result: MulticallResult<unknown> | undefined): T | null {
  return result && result.success ? (result.result as T) : null;
}

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

function ok(text: string): void {
  line(`  ✅ ${text}`);
}

function bad(text: string): void {
  line(`  ❌ ${text}`);
}

async function checkCode(client: ChainClient, label: string, address: Address): Promise<boolean> {
  try {
    const code = await client.getCode(address);
    if (code === "0x" || code.length <= 2) {
      bad(`${label} has no code at ${address}`);
      return false;
    }
    ok(`${label} code ${(code.length - 2) / 2} bytes`);
    return true;
  } catch (error) {
    bad(`${label} code read failed: ${safeError(error)}`);
    return false;
  }
}

async function probeV3(client: ChainClient, chain: ChainDescriptor, venueIndex: number): Promise<boolean> {
  const venue = chain.v3Venues[venueIndex]!;
  line(`  · ${venue.dex} ${venue.positionManager}`);
  let healthy = true;
  try {
    const [supplyResult, sampleResult] = await client.multicallSafe<bigint>([
      { address: venue.positionManager, abi: erc721EnumerableAbi, functionName: "totalSupply", args: [] },
      { address: venue.positionManager, abi: erc721EnumerableAbi, functionName: "tokenByIndex", args: [0n] },
    ], await client.getBlockNumber());
    const supply = unwrap<bigint>(supplyResult);
    if (supply === null) {
      bad("totalSupply() failed — is this really an ERC-721 position manager?");
      return false;
    }
    ok(`totalSupply=${supply.toString()}`);
    if (supply === 0n) {
      line("    (no positions minted yet; skipping sample)");
      return true;
    }
    const tokenId = unwrap<bigint>(sampleResult);
    if (tokenId === null) {
      bad("tokenByIndex(0) failed — this NPM may not be ERC721Enumerable");
      return false;
    }
    ok(`Enumerable: tokenByIndex(0) -> #${tokenId}`);

    const [ownerResult, positionResult] = await client.multicallSafe<unknown>([
      { address: venue.positionManager, abi: v3PositionManagerAbi, functionName: "ownerOf", args: [tokenId] },
      { address: venue.positionManager, abi: v3PositionManagerAbi, functionName: "positions", args: [tokenId] },
    ], await client.getBlockNumber());
    const owner = unwrap<Address>(ownerResult);
    const raw = unwrap<readonly unknown[]>(positionResult);
    if (owner === null || raw === null) {
      bad("ownerOf/positions sample failed");
      return false;
    }
    ok(`ownerOf(#${tokenId}) -> ${owner}`);
    const state = decodeV3Position(raw);
    ok(`positions() -> ${state.token0}/${state.token1} fee=${state.fee} ticks=[${state.tickLower}, ${state.tickUpper}) liquidity=${state.liquidity}`);

    const [poolResult] = await client.multicallSafe<Address>([{
      address: venue.factory, abi: v3FactoryAbi, functionName: "getPool", args: [state.token0, state.token1, state.fee],
    }], await client.getBlockNumber());
    const pool = unwrap<Address>(poolResult);
    if (pool === null || /^0x0+$/.test(pool)) {
      bad("factory.getPool returned zero for a live position");
      return false;
    }
    ok(`factory.getPool -> ${pool}`);

    const [spacingResult, slot0Result] = await client.multicallSafe<unknown>([
      { address: pool, abi: v3PoolAbi, functionName: "tickSpacing", args: [] },
      { address: pool, abi: v3PoolAbi, functionName: "slot0", args: [] },
    ], await client.getBlockNumber());
    const spacing = unwrap<number>(spacingResult);
    const slot0 = unwrap<readonly unknown[]>(slot0Result);
    if (spacing === null || slot0 === null) {
      bad("pool tickSpacing/slot0 read failed");
      healthy = false;
    } else {
      ok(`pool tickSpacing=${Number(spacing)} currentTick=${Number(slot0[1])}`);
    }
  } catch (error) {
    bad(`v3 probe failed: ${safeError(error)}`);
    healthy = false;
  }
  return healthy;
}

async function probeV4(client: ChainClient, chain: ChainDescriptor, chunkSize: bigint): Promise<boolean> {
  const v4 = chain.v4;
  if (v4 === null) return true;
  let healthy = true;
  try {
    const head = await client.getBlockNumber();
    // The endpoint rejects ranges beyond the configured chunk; use exactly one.
    const fromBlock = head > chunkSize ? head - chunkSize : 0n;
    const logs = await client.getLogsOnce({
      address: v4.positionManager,
      topics: [[TRANSFER_SELECTOR]],
      fromBlock,
      toBlock: head,
    });
    ok(`v4 PositionManager transfer logs in last ${chunkSize} blocks: ${logs.length}`);
    const last = logs[logs.length - 1];
    if (last === undefined) {
      line("    (no recent v4 mint/transfer to sample; skipping)");
      return true;
    }
    const topic = last.topics[3];
    if (topic === undefined) {
      bad("transfer log has no tokenId topic");
      return false;
    }
    const tokenId = BigInt(topic);
    const [ownerResult, infoResult, liquidityResult] = await client.multicallSafe<unknown>([
      { address: v4.positionManager, abi: v4PositionManagerAbi, functionName: "ownerOf", args: [tokenId] },
      { address: v4.positionManager, abi: v4PositionManagerAbi, functionName: "getPoolAndPositionInfo", args: [tokenId] },
      { address: v4.positionManager, abi: v4PositionManagerAbi, functionName: "getPositionLiquidity", args: [tokenId] },
    ], head);
    const owner = unwrap<Address>(ownerResult);
    const info = unwrap<readonly [{
      currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address;
    }, bigint]>(infoResult);
    const liquidity = unwrap<bigint>(liquidityResult);
    if (owner === null || info === null || liquidity === null) {
      bad("v4 sample token reads failed");
      return false;
    }
    const [poolKey, packed] = info;
    const { tickLower, tickUpper } = decodePositionTicks(BigInt(packed));
    const poolId = computeV4PoolId(poolKey);
    ok(`v4 #${tokenId} owner=${owner} ticks=[${tickLower}, ${tickUpper}) liquidity=${liquidity}`);
    ok(`computed PoolId=${poolId}`);

    const [slot0Result, poolLiquidityResult] = await client.multicallSafe<unknown>([
      { address: v4.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId] },
      { address: v4.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [poolId] },
    ], head);
    const slot0 = unwrap<readonly unknown[]>(slot0Result);
    const poolLiquidity = unwrap<bigint>(poolLiquidityResult);
    if (slot0 === null || poolLiquidity === null) {
      bad("v4 StateView read failed");
      healthy = false;
    } else {
      ok(`StateView tick=${Number(slot0[1])} sqrtPriceX96=${BigInt(String(slot0[0]))} liquidity=${poolLiquidity}`);
    }
  } catch (error) {
    bad(`v4 probe failed: ${safeError(error)}`);
    healthy = false;
  }
  return healthy;
}

async function probeLogRange(client: ChainClient, chain: ChainDescriptor): Promise<void> {
  const address = chain.v4?.positionManager;
  if (address === undefined) return;
  const head = await client.getBlockNumber();
  const ranges = [5_000n, 10_000n, 50_000n, 100_000n];
  let largest = 0n;
  for (const range of ranges) {
    if (head < range) break;
    const fromBlock = head - range;
    const started = Date.now();
    try {
      const logs = await client.getLogsOnce({
        address,
        topics: [[TRANSFER_SELECTOR]],
        fromBlock,
        toBlock: head,
      });
      largest = range;
      ok(`eth_getLogs ${range} blocks ok in ${Date.now() - started}ms (${logs.length} logs)`);
    } catch (error) {
      bad(`eth_getLogs ${range} blocks rejected after ${Date.now() - started}ms: ${safeError(error)}`);
      break;
    }
  }
  line(`  → recommended initial LOG_CHUNK_SIZE for ${chain.key}: ${largest === 0n ? "probe manually" : largest.toString()}`);
}

async function probeChain(config: ChainConfig): Promise<boolean> {
  const chain = config.descriptor;
  const client = createChainClient({ chain, rpcUrl: config.rpcUrl, chunkSize: config.indexer.chunkSize });
  line(`\n=== ${chain.name} (${chain.key}) ===`);
  let healthy = true;

  try {
    const actual = await client.getChainId();
    if (actual === chain.chainId) ok(`eth_chainId=${actual} (matches descriptor)`);
    else {
      bad(`eth_chainId=${actual}, expected ${chain.chainId}`);
      healthy = false;
    }
    const head = await client.getBlockNumber();
    ok(`blockNumber=${head}`);
  } catch (error) {
    bad(`RPC unreachable: ${safeError(error)}`);
    return false;
  }

  if (!await checkCode(client, "Multicall3", chain.multicall3)) healthy = false;
  try {
    const [chainIdResult] = await client.multicallSafe<bigint>([{
      address: chain.multicall3, abi: multicall3Abi, functionName: "getChainId", args: [],
    }], await client.getBlockNumber());
    const multicallChainId = unwrap<bigint>(chainIdResult);
    if (multicallChainId === null) bad("Multicall3 getChainId failed");
    else if (multicallChainId !== chain.chainId) bad(`Multicall3 getChainId=${multicallChainId}, expected ${chain.chainId}`);
    else ok(`Multicall3 getChainId=${multicallChainId}`);
  } catch (error) {
    bad(`Multicall3 call failed: ${safeError(error)}`);
    healthy = false;
  }

  for (let index = 0; index < chain.v3Venues.length; index += 1) {
    const venue = chain.v3Venues[index]!;
    if (!await checkCode(client, `${venue.dex} NPM`, venue.positionManager)) healthy = false;
    if (!await checkCode(client, `${venue.dex} factory`, venue.factory)) healthy = false;
    if (!await probeV3(client, chain, index)) healthy = false;
  }

  if (chain.v4 !== null) {
    if (!await checkCode(client, "v4 PoolManager", chain.v4.poolManager)) healthy = false;
    if (!await checkCode(client, "v4 PositionManager", chain.v4.positionManager)) healthy = false;
    if (!await checkCode(client, "v4 StateView", chain.v4.stateView)) healthy = false;
    if (!await probeV4(client, chain, config.indexer.chunkSize)) healthy = false;
    await probeLogRange(client, chain);
  }

  return healthy;
}

const configs = loadChainConfigs();
let allHealthy = true;
for (const config of configs) {
  const healthy = await probeChain(config);
  allHealthy = allHealthy && healthy;
}

line(`\n${allHealthy ? "probe complete: all sections healthy" : "probe complete: review the ❌ lines above"}`);
process.exitCode = allHealthy ? 0 : 1;
