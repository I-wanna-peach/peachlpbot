import { describe, expect, test } from "bun:test";
import { evaluateRange, isInRange, rangeChanged, shouldNotify } from "../src/monitor/range.js";

const base = { tickLower: -100, tickUpper: 100, outConfirmBlocks: 2, inConfirmBlocks: 3 };

describe("isInRange", () => {
  test("lower bound inclusive, upper bound exclusive", () => {
    expect(isInRange(-100, -100, 100)).toBe(true);
    expect(isInRange(99, -100, 100)).toBe(true);
    expect(isInRange(100, -100, 100)).toBe(false);
    expect(isInRange(-101, -100, 100)).toBe(false);
  });
});

describe("evaluateRange", () => {
  test("needs two distinct blocks out, then stops changing and never re-notifies", () => {
    const first = evaluateRange({ ...base, currentTick: 200, rangeState: "IN_RANGE", outStreak: 0, inStreak: 0 });
    expect(first.transition).toBeNull();
    expect(first.outStreak).toBe(1);

    const second = evaluateRange({ ...base, currentTick: 200, rangeState: first.rangeState, outStreak: first.outStreak, inStreak: first.inStreak });
    expect(second.transition).toEqual({ from: "IN_RANGE", to: "OUT_OF_RANGE" });
    expect(second.rangeState).toBe("OUT_OF_RANGE");
    expect(second.outStreak).toBe(2);

    const third = evaluateRange({ ...base, currentTick: 200, rangeState: second.rangeState, outStreak: second.outStreak, inStreak: second.inStreak });
    expect(third.transition).toBeNull();
    expect(third.outStreak).toBe(2);
    expect(rangeChanged({ rangeState: second.rangeState, outStreak: second.outStreak, inStreak: second.inStreak }, third)).toBe(false);
  });

  test("a one-block excursion never notifies", () => {
    const out = evaluateRange({ ...base, currentTick: 200, rangeState: "IN_RANGE", outStreak: 0, inStreak: 0 });
    const back = evaluateRange({ ...base, currentTick: 0, rangeState: out.rangeState, outStreak: out.outStreak, inStreak: out.inStreak });
    expect(back.transition).toBeNull();
    expect(back.outStreak).toBe(0);
    expect(back.inStreak).toBe(1);
  });

  test("back in range requires three blocks", () => {
    let state: { rangeState: "OUT_OF_RANGE" | "IN_RANGE" | "UNKNOWN"; outStreak: number; inStreak: number } = {
      rangeState: "OUT_OF_RANGE", outStreak: 2, inStreak: 0,
    };
    for (let block = 0; block < 2; block += 1) {
      const decision = evaluateRange({ ...base, currentTick: 0, ...state });
      expect(decision.transition).toBeNull();
      state = { rangeState: decision.rangeState, outStreak: decision.outStreak, inStreak: decision.inStreak };
    }
    const decision = evaluateRange({ ...base, currentTick: 0, ...state });
    expect(decision.transition).toEqual({ from: "OUT_OF_RANGE", to: "IN_RANGE" });
    expect(decision.inStreak).toBe(3);
  });

  test("UNKNOWN -> OUT_OF_RANGE notifies; UNKNOWN -> IN_RANGE does not", () => {
    const out = evaluateRange({ ...base, currentTick: 200, rangeState: "UNKNOWN", outStreak: 1, inStreak: 0 });
    expect(out.transition).toEqual({ from: "UNKNOWN", to: "OUT_OF_RANGE" });
    expect(shouldNotify(out.transition)).toBe(true);

    const inside = evaluateRange({ ...base, currentTick: 0, rangeState: "UNKNOWN", outStreak: 0, inStreak: 2 });
    expect(inside.transition).toEqual({ from: "UNKNOWN", to: "IN_RANGE" });
    expect(shouldNotify(inside.transition)).toBe(false);
  });
});

describe("shouldNotify", () => {
  test("only out-of-range, or a return from out-of-range", () => {
    expect(shouldNotify(null)).toBe(false);
    expect(shouldNotify({ from: "IN_RANGE", to: "OUT_OF_RANGE" })).toBe(true);
    expect(shouldNotify({ from: "OUT_OF_RANGE", to: "IN_RANGE" })).toBe(true);
  });

  test("back-in can be suppressed", () => {
    expect(shouldNotify({ from: "OUT_OF_RANGE", to: "IN_RANGE" }, false)).toBe(false);
    expect(shouldNotify({ from: "IN_RANGE", to: "OUT_OF_RANGE" }, false)).toBe(true);
  });
});
