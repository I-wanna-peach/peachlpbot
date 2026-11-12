import type { Address } from "viem";
import type { ChainDescriptor } from "../chains.js";
import type { TokenInfo } from "../types.js";

const MIN_TICK = -887272;
const MAX_TICK = 887272;

export type PriceSide = "BELOW" | "ABOVE" | null;

export interface PriceView {
  pairLabel: string;
  /** Quote per base, e.g. "740.02 USDT per META". */
  currentPrice: string;
  /** Quote per base range, or "Full range". */
  rangePriceLabel: string;
  /** Numeric display values used by the compact alert layout. */
  currentValue: string;
  lowerValue: string;
  upperValue: string;
  fullRange: boolean;
  side: PriceSide;
}

/** Uniswap tick -> raw token1/token0 price, adjusted for token decimals. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.exp(tick * Math.log(1.0001)) * 10 ** (decimals0 - decimals1);
}

/** Full-range positions use the min/max usable tick for their spacing. */
export function isFullRange(tickLower: number, tickUpper: number, tickSpacing: number): boolean {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) return false;
  const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return tickLower <= minUsable && tickUpper >= maxUsable;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** Numeric formatting only; the unit is appended by the caller. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value === 0) return "0";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return trimZeros(value.toFixed(4));
  if (value >= 0.01) return trimZeros(value.toFixed(6));
  if (value >= 0.0001) return trimZeros(value.toFixed(8));
  return value.toPrecision(4);
}

/**
 * Picks the quote side from the chain's preference list (BSC: USDT > USDC >
 * WBNB > BNB; Arc: USDC > native USDC > EURC). Falling back to token1 keeps the
 * orientation explicit when neither side is a known quote asset.
 */
export function quoteIsCurrency0(chain: ChainDescriptor, currency0: Address, currency1: Address): boolean {
  const c0 = currency0.toLowerCase();
  const c1 = currency1.toLowerCase();
  for (const token of chain.quoteTokens) {
    const key = token.toLowerCase();
    if (key === c0) return true;
    if (key === c1) return false;
  }
  return false;
}

/**
 * Builds the relative-price view directly from the pool's tick order. There is
 * no USD valuation: the price is always QUOTE per BASE using the chain's quote
 * preference. Unknown metadata returns null (no fabricated price).
 */
export function buildPriceView(input: {
  chain: ChainDescriptor;
  currency0: Address;
  currency1: Address;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  tickSpacing: number;
  metadata: ReadonlyMap<string, TokenInfo>;
}): PriceView | null {
  const info0 = input.metadata.get(input.currency0.toLowerCase());
  const info1 = input.metadata.get(input.currency1.toLowerCase());
  if (info0 === undefined || info1 === undefined) return null;

  const quoteIs0 = quoteIsCurrency0(input.chain, input.currency0, input.currency1);
  const quoteInfo = quoteIs0 ? info0 : info1;
  const baseInfo = quoteIs0 ? info1 : info0;

  // Uniswap's native price is token1/token0; invert it when token0 is the quote.
  const display = (tick: number): number => {
    const price01 = tickToPrice(tick, info0.decimals, info1.decimals);
    return quoteIs0 ? 1 / price01 : price01;
  };

  const fullRange = isFullRange(input.tickLower, input.tickUpper, input.tickSpacing);
  const current = display(input.currentTick);
  if (!Number.isFinite(current)) return null;

  let rangePriceLabel: string;
  let side: PriceSide = null;
  let lowerValue = "—";
  let upperValue = "—";
  if (fullRange) {
    rangePriceLabel = "Full range";
  } else {
    const a = display(input.tickLower);
    const b = display(input.tickUpper);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    lowerValue = formatPrice(low);
    upperValue = formatPrice(high);
    rangePriceLabel = `${lowerValue} – ${upperValue} ${quoteInfo.symbol} per ${baseInfo.symbol}`;
    if (current < low) side = "BELOW";
    else if (current > high) side = "ABOVE";
  }

  return {
    pairLabel: `${baseInfo.symbol} / ${quoteInfo.symbol}`,
    currentPrice: `${formatPrice(current)} ${quoteInfo.symbol} per ${baseInfo.symbol}`,
    currentValue: formatPrice(current),
    lowerValue,
    upperValue,
    rangePriceLabel,
    fullRange,
    side,
  };
}
