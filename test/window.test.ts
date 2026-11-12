import { describe, expect, test } from "bun:test";
import { bootstrapStartBlock } from "../src/indexer/window.js";

describe("bootstrapStartBlock", () => {
  test("an explicit start block always wins", () => {
    expect(bootstrapStartBlock({ head: 10_000_000n, startBlock: 9000n, lookbackBlocks: 2_000_000n })).toBe(9000n);
  });
  test("otherwise the window is bounded by the lookback", () => {
    expect(bootstrapStartBlock({ head: 10_000_000n, startBlock: null, lookbackBlocks: 2_000_000n })).toBe(8_000_000n);
  });
  test("a lookback longer than the chain clamps to genesis", () => {
    expect(bootstrapStartBlock({ head: 500n, startBlock: null, lookbackBlocks: 2_000_000n })).toBe(0n);
  });
});
