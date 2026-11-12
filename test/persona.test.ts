import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { renderIncident, watchResult } from "../src/bot/persona.js";

const OWNER = getAddress("0xa7A01B93B889ff0639d5ec02914A77529924a46F");
const CURRENCY0 = getAddress("0x55d398326f99059fF775485246999027B3197955");
const CURRENCY1 = getAddress("0xBdEAe1cA48894A1759A8374D63925f21f2Ee2639");

function rangePayload(): Record<string, unknown> {
  return {
    tokenId: "62391",
    dex: "PANCAKE_V3",
    poolRef: "0x6425bc30d0751af5181fc74a50e760b0e4a19811",
    owner: OWNER,
    currency0: CURRENCY0,
    currency1: CURRENCY1,
    fee: 2500,
    currentTick: 26517,
    tickLower: -10_000,
    tickUpper: 2_400,
    rulesVersion: "1",
    confirmations: 2,
    chainId: "56",
    chainLabel: "BSC",
    price: {
      pairLabel: "EDU / USDT",
      currentPrice: "0.070541 USDT per EDU",
      currentValue: "0.070541",
      lowerValue: "0.786637",
      upperValue: "2.7181",
      rangePriceLabel: "0.786637 – 2.7181 USDT per EDU",
      fullRange: false,
      side: "BELOW",
    },
  };
}

describe("renderIncident", () => {
  test("range card carries chain, venue and the overview block", () => {
    const text = renderIncident("LP_OUT_OF_RANGE", rangePayload(), "whale", { html: true });
    expect(text).toContain("BSC");
    expect(text).toContain("PancakeSwap V3 out of range");
    expect(text).toContain("<blockquote><b>Overview</b>");
    expect(text).toContain("Current Price: 0.070541");
    expect(text).toContain("Upper Price:   2.7181");
    expect(text).toContain("Lower Price:   0.786637");
  });

  test("nickname is HTML-escaped in range cards", () => {
    const text = renderIncident("LP_OUT_OF_RANGE", rangePayload(), "<script>", { html: true });
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script>");
  });

  test("back-in-range uses the success tone", () => {
    const text = renderIncident("LP_BACK_IN_RANGE", rangePayload(), null, { html: false });
    expect(text).toContain("back in range");
    expect(text).toContain("Wallet");
  });

  test("position change links the transaction", () => {
    const text = renderIncident("LP_POSITION_CHANGED", {
      kind: "CLOSED",
      tokenId: "1",
      dex: "PANCAKE_V3",
      poolRef: "0xabc",
      currency0: CURRENCY0,
      currency1: CURRENCY1,
      symbol0: "USDT",
      symbol1: "EDU",
      tickLower: -100,
      tickUpper: 100,
      chainLabel: "BSC",
      explorerTxUrl: "https://bscscan.com/tx/0xdead",
    });
    expect(text).toContain("has been closed");
    expect(text).toContain("Chain: BSC");
    expect(text).toContain("Pool: USDT / EDU");
    expect(text).toContain("https://bscscan.com/tx/0xdead");
  });
});

describe("watchResult", () => {
  test("lists per-chain counts and totals", () => {
    const text = watchResult(OWNER, "whale", [
      { label: "BSC", positions: 3, error: false },
      { label: "ARC", positions: 1, error: false },
    ]);
    expect(text).toContain("BSC: 3 positions");
    expect(text).toContain("ARC: 1 position");
  });

  test("an unavailable chain is reported without hiding the other", () => {
    const text = watchResult(OWNER, null, [
      { label: "BSC", positions: null, error: true },
      { label: "ARC", positions: 2, error: false },
    ]);
    expect(text).toContain("BSC: unavailable");
    expect(text).toContain("ARC: 2 positions");
  });
});
