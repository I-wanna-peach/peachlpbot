import type { RangeState } from "../types.js";

/**
 * Concentrated-liquidity range predicate. The upper bound is EXCLUSIVE, matching
 * Uniswap's own definition: a position is active for `tickLower <= tick < tickUpper`.
 */
export function isInRange(currentTick: number, tickLower: number, tickUpper: number): boolean {
  return tickLower <= currentTick && currentTick < tickUpper;
}

export interface RangeInput {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  rangeState: RangeState;
  outStreak: number;
  inStreak: number;
  outConfirmBlocks: number;
  inConfirmBlocks: number;
}

export interface RangeTransition {
  from: RangeState;
  to: RangeState;
}

export interface RangeDecision {
  observed: "IN_RANGE" | "OUT_OF_RANGE";
  rangeState: RangeState;
  outStreak: number;
  inStreak: number;
  transition: RangeTransition | null;
}

/**
 * Debounced range state machine.
 *
 * Streaks are CAPPED at their confirmation threshold, so once a position settles
 * into a stable state the persisted row stops changing every block. A transition
 * happens only when the required number of distinct blocks agreed, and only when
 * the resulting state differs from the stored one -- so one continuous spell out
 * of range produces exactly one transition, never one event per block.
 */
export function evaluateRange(input: RangeInput): RangeDecision {
  if (!Number.isInteger(input.outConfirmBlocks) || input.outConfirmBlocks < 1) throw new Error("outConfirmBlocks must be >= 1.");
  if (!Number.isInteger(input.inConfirmBlocks) || input.inConfirmBlocks < 1) throw new Error("inConfirmBlocks must be >= 1.");

  const observed = isInRange(input.currentTick, input.tickLower, input.tickUpper) ? "IN_RANGE" : "OUT_OF_RANGE";
  const outStreak = observed === "OUT_OF_RANGE"
    ? Math.min(input.outStreak + 1, input.outConfirmBlocks)
    : 0;
  const inStreak = observed === "IN_RANGE"
    ? Math.min(input.inStreak + 1, input.inConfirmBlocks)
    : 0;

  if (observed === "OUT_OF_RANGE" && outStreak >= input.outConfirmBlocks && input.rangeState !== "OUT_OF_RANGE") {
    return { observed, rangeState: "OUT_OF_RANGE", outStreak, inStreak, transition: { from: input.rangeState, to: "OUT_OF_RANGE" } };
  }
  if (observed === "IN_RANGE" && inStreak >= input.inConfirmBlocks && input.rangeState !== "IN_RANGE") {
    return { observed, rangeState: "IN_RANGE", outStreak, inStreak, transition: { from: input.rangeState, to: "IN_RANGE" } };
  }
  return { observed, rangeState: input.rangeState, outStreak, inStreak, transition: null };
}

/** Whether a transition is worth notifying: out-of-range always, back-in only when enabled. */
export function shouldNotify(transition: RangeTransition | null, notifyBackInRange = true): boolean {
  if (transition === null) return false;
  if (transition.to === "OUT_OF_RANGE") return true;
  return notifyBackInRange && transition.from === "OUT_OF_RANGE";
}

export function rangeChanged(before: { rangeState: RangeState; outStreak: number; inStreak: number }, after: RangeDecision): boolean {
  return before.rangeState !== after.rangeState
    || before.outStreak !== after.outStreak
    || before.inStreak !== after.inStreak;
}
