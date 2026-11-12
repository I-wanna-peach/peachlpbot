import { getAddress, type Address } from "viem";

export interface V3PositionState {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/**
 * Uniswap V3 and PancakeSwap V3 `positions()` both return the canonical 12-field
 * tuple; the first two fields (`nonce`, `operator`) are not needed here. Keep the
 * indices explicit so a fork with a different layout is a compile-time decision,
 * not a guess based on array length.
 */
export function decodeV3Position(position: readonly unknown[]): V3PositionState {
  return {
    token0: getAddress(String(position[2])),
    token1: getAddress(String(position[3])),
    fee: Number(position[4]),
    tickLower: Number(position[5]),
    tickUpper: Number(position[6]),
    liquidity: BigInt(String(position[7])),
  };
}
