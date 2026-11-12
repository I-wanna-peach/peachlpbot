import { defineChain, getAddress, type Address, type Chain } from "viem";

/**
 * Every chain address is declared here and nowhere else. Sources:
 * - Uniswap `github.com/Uniswap/contracts/deployments/56.md` and `5042.md`
 * - PancakeSwap V3 deployment addresses (BSC)
 * - Arc mainnet predeploys (USDC / EURC) documented by Circle and Arc DEXes
 *
 * Do not "fix" an address in a business module: add it here so both the
 * indexer and the monitor read the same value.
 */

export type Dex = "UNISWAP_V3" | "PANCAKE_V3" | "UNISWAP_V4";

export const DEX_V3: Dex = "UNISWAP_V3";
export const DEX_PANCAKE_V3: Dex = "PANCAKE_V3";
export const DEX_V4: Dex = "UNISWAP_V4";

export type ChainKey = "bsc" | "arc";

export interface V3Venue {
  dex: Dex;
  positionManager: Address;
  factory: Address;
}

export interface V4Addresses {
  poolManager: Address;
  positionManager: Address;
  stateView: Address;
}

export interface ChainDefaults {
  logChunkSize: bigint;
  lookbackBlocks: bigint;
  maxChunksPerRun: number;
  pollIntervalMs: number;
  reorgRewind: bigint;
  tailWindowBlocks: bigint;
}

export interface ChainDescriptor {
  key: ChainKey;
  chainId: bigint;
  name: string;
  /** Compact badge used in Telegram alerts: BSC / ARC. */
  shortLabel: string;
  nativeSymbol: string;
  explorerUrl: string;
  multicall3: Address;
  /**
   * Quote preference, most preferred first. A pool's display price is always
   * "quote per base" using the first of these that appears in the pair.
   * The zero address is the native asset (BNB on BSC, USDC on Arc).
   */
  quoteTokens: readonly Address[];
  v3Venues: readonly V3Venue[];
  v4: V4Addresses | null;
  defaults: ChainDefaults;
  viemChain: Chain;
  /** Lowercased PositionManager address -> venue, used by the log decoder. */
  v3VenueByManager: ReadonlyMap<string, V3Venue>;
}

const ZERO = getAddress("0x0000000000000000000000000000000000000000");

function descriptor(input: Omit<ChainDescriptor, "viemChain" | "v3VenueByManager">): ChainDescriptor {
  const viemChain = defineChain({
    id: Number(input.chainId),
    name: input.name,
    nativeCurrency: { name: input.nativeSymbol, symbol: input.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [] } },
    blockExplorers: { default: { name: `${input.name} Explorer`, url: input.explorerUrl } },
    contracts: { multicall3: { address: input.multicall3 } },
  });
  return {
    ...input,
    viemChain,
    v3VenueByManager: new Map(input.v3Venues.map((venue) => [venue.positionManager.toLowerCase(), venue] as const)),
  };
}

/** BNB Smart Chain (chainId 56). BSC produces ~0.75s blocks. */
export const BSC: ChainDescriptor = descriptor({
  key: "bsc",
  chainId: 56n,
  name: "BNB Smart Chain",
  shortLabel: "BSC",
  nativeSymbol: "BNB",
  explorerUrl: "https://bscscan.com",
  multicall3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  quoteTokens: [
    getAddress("0x55d398326f99059fF775485246999027B3197955"), // USDT
    getAddress("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"), // USDC
    getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), // WBNB
    ZERO, // native BNB
  ],
  v3Venues: [
    {
      dex: DEX_V3,
      positionManager: getAddress("0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613"),
      factory: getAddress("0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7"),
    },
    {
      dex: DEX_PANCAKE_V3,
      positionManager: getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364"),
      factory: getAddress("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
    },
  ],
  v4: {
    poolManager: getAddress("0x28e2ea090877bf75740558f6bfb36a5ffee9e9df"),
    positionManager: getAddress("0x7a4a5c919ae2541aed11041a1aeee68f1287f95b"),
    stateView: getAddress("0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4"),
  },
  defaults: {
    logChunkSize: 5_000n,
    lookbackBlocks: 5_000_000n,
    maxChunksPerRun: 50,
    pollIntervalMs: 5_000,
    reorgRewind: 128n,
    tailWindowBlocks: 20_000n,
  },
});

/**
 * Arc (chainId 5042) — Circle's USDC-native L1, ~0.5s blocks, BFT finality.
 * Gas is native USDC at 18 decimals; the ERC-20 USDC interface at
 * 0x3600…0000 is 6 decimals over the same balance. Never mix the two.
 * 0x8bcE…937f is Uniswap's `UnsupportedProtocol` WETH placeholder, not a token.
 */
export const ARC: ChainDescriptor = descriptor({
  key: "arc",
  chainId: 5042n,
  name: "Arc",
  shortLabel: "ARC",
  nativeSymbol: "USDC",
  explorerUrl: "https://explorer.arc.io",
  multicall3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  quoteTokens: [
    getAddress("0x3600000000000000000000000000000000000000"), // USDC (ERC-20, 6dp)
    ZERO, // native USDC (18dp)
    getAddress("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1"), // EURC
  ],
  v3Venues: [
    {
      dex: DEX_V3,
      positionManager: getAddress("0x39654a85a4c05127f5fd6ed22caec077a0fb1377"),
      factory: getAddress("0xf0db7b58379503491d857db50ac9ece64c653918"),
    },
  ],
  v4: {
    poolManager: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
    positionManager: getAddress("0x6049c9a0e26405c0985f9e3685c87d0ae917f82b"),
    stateView: getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
  },
  defaults: {
    logChunkSize: 10_000n,
    lookbackBlocks: 2_000_000n,
    maxChunksPerRun: 50,
    pollIntervalMs: 3_000,
    reorgRewind: 128n,
    tailWindowBlocks: 20_000n,
  },
});

export const CHAINS: readonly ChainDescriptor[] = [BSC, ARC];

export const CHAIN_BY_KEY: ReadonlyMap<string, ChainDescriptor> = new Map(
  CHAINS.map((chain) => [chain.key, chain] as const),
);

export const CHAIN_BY_ID: ReadonlyMap<string, ChainDescriptor> = new Map(
  CHAINS.map((chain) => [chain.chainId.toString(), chain] as const),
);

/** Every v3 venue across supported chains, used by the probe script. */
export const ALL_V3_VENUES: readonly { chain: ChainDescriptor; venue: V3Venue }[] =
  CHAINS.flatMap((chain) => chain.v3Venues.map((venue) => ({ chain, venue })));
