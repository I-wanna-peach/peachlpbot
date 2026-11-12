import { describe, expect, test } from "bun:test";
import { getAddress, type Hex } from "viem";
import {
  mergePositionChange,
  positionChangeKey,
  type PendingPositionChange,
} from "../src/indexer/position-changes.js";

const OWNER_A = getAddress("0x1111111111111111111111111111111111111111");
const OWNER_B = getAddress("0x2222222222222222222222222222222222222222");
const TX = `0x${"11".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"22".repeat(32)}` as Hex;

function change(overrides: Partial<PendingPositionChange> = {}): PendingPositionChange {
  return {
    dex: "UNISWAP_V4",
    tokenId: 3086221n,
    owner: OWNER_A,
    kind: "INCREASED",
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    logIndex: 1,
    poolRef: null,
    tickLower: null,
    tickUpper: null,
    liquidityDelta: 1n,
    amount0: null,
    amount1: null,
    ...overrides,
  };
}

describe("mergePositionChange", () => {
  test("a mint plus its liquidity event becomes one OPENED notice", () => {
    const changes = new Map<string, PendingPositionChange>();
    mergePositionChange(changes, change({ kind: "OPENED", owner: OWNER_A, liquidityDelta: null }));
    mergePositionChange(changes, change({
      kind: "INCREASED",
      owner: OWNER_A,
      poolRef: `0x${"ab".repeat(32)}`,
      tickLower: -100,
      tickUpper: 100,
      liquidityDelta: 500n,
    }));

    expect(changes.size).toBe(1);
    const merged = [...changes.values()][0]!;
    expect(merged.kind).toBe("OPENED");
    expect(merged.poolRef).toBe(`0x${"ab".repeat(32)}`);
    expect(merged.tickLower).toBe(-100);
    expect(merged.tickUpper).toBe(100);
    expect(merged.liquidityDelta).toBe(500n);
  });

  test("a burn plus its decrease becomes one CLOSED notice", () => {
    const changes = new Map<string, PendingPositionChange>();
    mergePositionChange(changes, change({ kind: "CLOSED", owner: OWNER_A }));
    mergePositionChange(changes, change({ kind: "DECREASED", owner: OWNER_A, liquidityDelta: -500n }));

    expect(changes.size).toBe(1);
    expect([...changes.values()][0]!.kind).toBe("CLOSED");
  });

  test("a transfer records both the old and the new owner", () => {
    const changes = new Map<string, PendingPositionChange>();
    mergePositionChange(changes, change({ kind: "TRANSFERRED_OUT", owner: OWNER_A }));
    mergePositionChange(changes, change({ kind: "TRANSFERRED_IN", owner: OWNER_B }));

    expect(changes.size).toBe(2);
    expect([...changes.values()].map((item) => item.kind).sort()).toEqual(["TRANSFERRED_IN", "TRANSFERRED_OUT"]);
  });

  test("a decrease outranks a collect in the same transaction", () => {
    const changes = new Map<string, PendingPositionChange>();
    mergePositionChange(changes, change({ kind: "COLLECTED", owner: OWNER_A, logIndex: 4, liquidityDelta: null }));
    mergePositionChange(changes, change({ kind: "DECREASED", owner: OWNER_A, logIndex: 3, liquidityDelta: -1n }));

    const merged = [...changes.values()][0]!;
    expect(merged.kind).toBe("DECREASED");
    expect(merged.logIndex).toBe(3);
  });

  test("keys are case-insensitive for owner and transaction hash", () => {
    const key = positionChangeKey(change({ owner: OWNER_A }));
    expect(key).toBe(positionChangeKey(change({ owner: getAddress(OWNER_A.toLowerCase()) })));
    expect(key).toBe(positionChangeKey(change({ transactionHash: TX.toUpperCase().replace("0X", "0x") as Hex })));
  });
});
