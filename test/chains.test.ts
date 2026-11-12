import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { ARC, BSC, CHAIN_BY_ID, CHAIN_BY_KEY, DEX_PANCAKE_V3, DEX_V3, DEX_V4 } from "../src/chains.js";

describe("chain registry", () => {
  test("BSC and Arc are registered by key and id", () => {
    expect(CHAIN_BY_KEY.get("bsc")).toBe(BSC);
    expect(CHAIN_BY_KEY.get("arc")).toBe(ARC);
    expect(CHAIN_BY_ID.get("56")).toBe(BSC);
    expect(CHAIN_BY_ID.get("5042")).toBe(ARC);
    expect(BSC.chainId).toBe(56n);
    expect(ARC.chainId).toBe(5042n);
  });

  test("BSC has Uniswap V3, Pancake V3 and Uniswap V4", () => {
    expect(BSC.v3Venues.map((venue) => venue.dex)).toEqual([DEX_V3, DEX_PANCAKE_V3]);
    expect(BSC.v4).not.toBeNull();
    expect(BSC.v3VenueByManager.get(getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364").toLowerCase())?.dex).toBe(DEX_PANCAKE_V3);
  });

  test("Arc has Uniswap V3 and Uniswap V4", () => {
    expect(ARC.v3Venues.map((venue) => venue.dex)).toEqual([DEX_V3]);
    expect(ARC.v4).not.toBeNull();
    expect(ARC.v3VenueByManager.get(getAddress("0x39654a85a4c05127f5fd6ed22caec077a0fb1377").toLowerCase())?.dex).toBe(DEX_V3);
  });

  test("the Arc WETH placeholder is nowhere in the quote list", () => {
    const placeholder = getAddress("0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f").toLowerCase();
    expect(ARC.quoteTokens.map((token) => token.toLowerCase())).not.toContain(placeholder);
  });

  test("v4 addresses differ per chain but v3 dex labels are stable", () => {
    expect(BSC.v4?.poolManager).not.toBe(ARC.v4?.poolManager);
    expect(DEX_V4).toBe("UNISWAP_V4");
  });
});
