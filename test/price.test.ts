import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { ARC, BSC } from "../src/chains.js";
import {
  buildPriceView,
  formatPrice,
  isFullRange,
  quoteIsCurrency0,
  tickToPrice,
} from "../src/monitor/price.js";
import type { TokenInfo } from "../src/types.js";

const META = getAddress("0x1b0e319c6a659f002271b69db8a7df2f911c153e");
const CBBTC = getAddress("0xcec185eb182c47d1ba1efc84e6959e18cd620be4");
const ZERO = getAddress("0x0000000000000000000000000000000000000000");
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const BSC_USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");

function metadata(entries: [string, TokenInfo][]): Map<string, TokenInfo> {
  return new Map(entries.map(([address, info]) => [address.toLowerCase(), info]));
}

describe("tickToPrice", () => {
  test("tick 0 with equal decimals is 1", () => {
    expect(tickToPrice(0, 18, 18)).toBe(1);
  });
  test("decimals adjust the raw ratio", () => {
    expect(tickToPrice(0, 6, 18)).toBeCloseTo(1e-12, 20);
  });
  test("positive ticks increase the token1/token0 price", () => {
    expect(tickToPrice(10_000, 18, 18)).toBeGreaterThan(tickToPrice(0, 18, 18));
  });
});

describe("isFullRange", () => {
  test("detects the min/max usable tick for the spacing", () => {
    expect(isFullRange(-887270, 887270, 10)).toBe(true);
    expect(isFullRange(-887220, 887220, 60)).toBe(true);
  });
  test("a narrow range is not full range", () => {
    expect(isFullRange(-1000, 1000, 10)).toBe(false);
  });
});

describe("formatPrice", () => {
  test("keeps a sensible number of decimals", () => {
    expect(formatPrice(740.0164)).toBe("740.0164");
    expect(formatPrice(32.832643)).toBe("32.8326");
    expect(formatPrice(0.01101305)).toBe("0.011013");
  });
  test("large values use separators and two decimals", () => {
    expect(formatPrice(1234.567)).toBe("1,234.57");
  });
});

describe("quoteIsCurrency0", () => {
  test("Arc prefers 6-decimal USDC, then native USDC, then EURC", () => {
    expect(quoteIsCurrency0(ARC, ARC_USDC, META)).toBe(true);
    expect(quoteIsCurrency0(ARC, META, ARC_USDC)).toBe(false);
    expect(quoteIsCurrency0(ARC, ZERO, META)).toBe(true);
  });
  test("BSC prefers USDT over WBNB", () => {
    expect(quoteIsCurrency0(BSC, getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), BSC_USDT)).toBe(false);
    expect(quoteIsCurrency0(BSC, BSC_USDT, META)).toBe(true);
  });
  test("an unknown pair falls back to token1 as quote", () => {
    expect(quoteIsCurrency0(BSC, META, CBBTC)).toBe(false);
  });
});

describe("buildPriceView", () => {
  const arcMeta = metadata([
    [ARC_USDC, { symbol: "USDC", decimals: 6 }],
    [META, { symbol: "META", decimals: 18 }],
  ]);
  const bscMeta = metadata([
    [getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), { symbol: "WBNB", decimals: 18 }],
    [META, { symbol: "META", decimals: 18 }],
    [CBBTC, { symbol: "cbBTC", decimals: 8 }],
  ]);

  test("USDC-quoted pool shows USDC per base and the below-range side", () => {
    const view = buildPriceView({
      chain: ARC,
      currency0: ARC_USDC, currency1: META,
      tickLower: 210_000, tickUpper: 210_200, currentTick: 210_254, tickSpacing: 10,
      metadata: arcMeta,
    });
    expect(view).not.toBeNull();
    expect(view?.pairLabel).toBe("META / USDC");
    expect(view?.currentPrice).toBe("740.0164 USDC per META");
    expect(view?.rangePriceLabel).toBe("744.0231 – 759.0526 USDC per META");
    expect(view?.side).toBe("BELOW");
    expect(view?.fullRange).toBe(false);
  });

  test("WBNB-quoted pool shows WBNB per base", () => {
    const view = buildPriceView({
      chain: BSC,
      currency0: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), currency1: CBBTC,
      tickLower: -265_400, tickUpper: -265_300, currentTick: -265_186, tickSpacing: 10,
      metadata: bscMeta,
    });
    expect(view?.pairLabel).toBe("cbBTC / WBNB");
    expect(view?.currentPrice).toBe("32.8326 WBNB per cbBTC");
    expect(view?.rangePriceLabel).toBe("33.2091 – 33.5428 WBNB per cbBTC");
    expect(view?.side).toBe("BELOW");
  });

  test("a full-range position says so instead of printing 1e39 bounds", () => {
    const view = buildPriceView({
      chain: BSC,
      currency0: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), currency1: META,
      tickLower: -887_270, tickUpper: 887_270, currentTick: 45_089, tickSpacing: 10,
      metadata: bscMeta,
    });
    expect(view?.fullRange).toBe(true);
    expect(view?.rangePriceLabel).toBe("Full range");
    expect(view?.side).toBeNull();
  });

  test("missing metadata yields no price view (fall back to ticks)", () => {
    const view = buildPriceView({
      chain: ARC,
      currency0: ARC_USDC, currency1: META,
      tickLower: 210_000, tickUpper: 210_200, currentTick: 210_254, tickSpacing: 10,
      metadata: new Map(),
    });
    expect(view).toBeNull();
  });
});
