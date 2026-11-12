import { describe, expect, test } from "bun:test";
import { decodeV3Position } from "../src/indexer/v3-layout.js";

const TOKEN0 = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const TOKEN1 = "0xE95fce3eEFcFf86B1d6a8951405432eA96505c98";

describe("decodeV3Position", () => {
  test("decodes the Uniswap/Pancake 12-field layout", () => {
    const state = decodeV3Position([
      0n,
      "0x0000000000000000000000000000000000000000",
      TOKEN0,
      TOKEN1,
      500,
      114620,
      115620,
      1319971787129752875n,
      0n,
      0n,
      0n,
      0n,
    ]);
    expect(state.token0).toBe(TOKEN0);
    expect(state.token1).toBe(TOKEN1);
    expect(state.fee).toBe(500);
    expect(state.tickLower).toBe(114620);
    expect(state.tickUpper).toBe(115620);
    expect(state.liquidity).toBe(1319971787129752875n);
  });
});
