import type { IncidentType } from "../types.js";

export function shortAddress(address: string | undefined): string {
  if (!address || address.length < 12) return address ?? "unknown";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function pairLabel(currency0: string | undefined, currency1: string | undefined): string {
  return `${shortAddress(currency0)} / ${shortAddress(currency1)}`;
}

/** Human label for the venue behind a position. */
export function venueLabel(dex: string): string {
  if (dex === "UNISWAP_V3") return "Uniswap V3";
  if (dex === "UNISWAP_V4") return "Uniswap V4";
  if (dex === "PANCAKE_V3") return "PancakeSwap V3";
  return dex.replace(/_/g, " ");
}

/** Per-venue alert icon. */
function venueIcon(dex: string): string {
  if (dex === "UNISWAP_V3" || dex === "UNISWAP_V4") return "🦄";
  if (dex === "PANCAKE_V3") return "🥞";
  return "🐳";
}

/** Compact label for `/positions`. */
function positionVenue(dex: string): string {
  if (dex === "UNISWAP_V3") return "V3";
  if (dex === "UNISWAP_V4") return "V4";
  if (dex === "PANCAKE_V3") return "PCS V3";
  return dex;
}

interface RangePrice {
  pairLabel: string;
  currentPrice: string;
  rangePriceLabel: string;
  currentValue?: string;
  lowerValue?: string;
  upperValue?: string;
  fullRange: boolean;
  side: "BELOW" | "ABOVE" | null;
}

interface RangePayload {
  tokenId: string;
  dex: string;
  poolRef: string;
  currency0: string;
  currency1: string;
  fee: number;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  rulesVersion: string;
  confirmations: number;
  owner?: string;
  chainLabel?: string;
  price?: RangePrice | null;
}

interface PositionChangePayload {
  kind: string;
  tokenId: string;
  dex: string;
  poolRef: string;
  currency0?: string | null;
  currency1?: string | null;
  symbol0?: string | null;
  symbol1?: string | null;
  tickLower?: number | null;
  tickUpper?: number | null;
  chainLabel?: string | null;
  explorerTxUrl?: string | null;
}

function asRange(payload: Record<string, unknown>): RangePayload {
  return payload as unknown as RangePayload;
}

function asPositionChange(payload: Record<string, unknown>): PositionChangePayload {
  return payload as unknown as PositionChangePayload;
}

/** Numeric values for the compact alert card; tolerate older payloads. */
function priceValues(price: RangePrice | null): { current: string; lower: string; upper: string } {
  if (price === null) return { current: "n/a", lower: "—", upper: "—" };
  const [rawLower, rawUpper] = price.rangePriceLabel.split(" – ");
  return {
    current: price.currentValue ?? price.currentPrice.split(/\s+/)[0] ?? "n/a",
    lower: price.lowerValue ?? (rawLower ? rawLower.split(/\s+/)[0] ?? "—" : "—"),
    upper: price.upperValue ?? (rawUpper ? rawUpper.split(/\s+/)[0] ?? "—" : "—"),
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const PEACHBOT_INTRO = [
  "Hi, I'm PeachBot 🦔 — a little hedgehog that keeps an eye on your LP positions on Arc.",
  "",
  "Send me an EVM address and I'll check its Uniswap V3 and V4 positions. I'll ping you when a position leaves its price range, comes back, or changes.",
  "",
  "Just send the address — I'll ask you to confirm it and give it a name.",
  "",
  "I only watch: no wallet connection, no approvals, no signatures. I can't move your funds, and everything I read is public on-chain data.",
].join("\n");

export function watchPrompt(address: string): string {
  return [
    `Got it — ${shortAddress(address)}.`,
    "",
    "I'll watch this address. First, let me check its LP positions on Arc.",
  ].join("\n");
}

export interface ChainDiscoverySummary {
  label: string;
  positions: number | null;
  error: boolean;
}

export function watchResult(address: string, nickname: string | null, results: readonly ChainDiscoverySummary[]): string {
  const label = nickname === null ? shortAddress(address) : `“${nickname}” (${shortAddress(address)})`;
  const lines = [`Watching ${label} 🦔`, ""];
  let total = 0;
  // Only mention a chain when it has something to report.
  for (const result of results) {
    if (result.positions === null) {
      lines.push(`${result.label}: unavailable right now, I'll retry shortly.`);
      continue;
    }
    if (result.positions === 0) continue;
    total += result.positions;
    lines.push(`${result.label}: ${result.positions} position${result.positions === 1 ? "" : "s"}`);
  }
  if (lines.length === 2) {
    lines.push("No active LP positions right now. If one shows up, I'll notice.");
  } else {
    lines.push("", "I'll keep an eye on their ranges.");
  }
  return lines.join("\n");
}

export function watchingList(rows: { nickname: string | null; watchedAddress: string; positions: number }[]): string {
  if (rows.length === 0) return "You're not watching any addresses yet. Send me one to get started.";
  const lines = ["Watching:"];
  for (const row of rows) {
    const label = row.nickname === null ? shortAddress(row.watchedAddress) : `“${row.nickname}” (${shortAddress(row.watchedAddress)})`;
    lines.push(`• ${label} — ${row.positions} position${row.positions === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

export interface PositionSummary {
  chainLabel: string;
  dex: string;
  tokenId: string;
  pair: string;
  rangeState: string;
  tickLower?: number;
  tickUpper?: number;
}

function rangeLabel(state: string): string {
  if (state === "IN_RANGE") return "in range";
  if (state === "OUT_OF_RANGE") return "OUT OF RANGE";
  return "pending";
}

/**
 * Compact one-line-per-position summary. Out-of-range positions are listed
 * first because they are the actionable ones; the list is capped so a large
 * portfolio cannot push the Telegram message over its size limit.
 */
export function positionsList(
  address: string,
  positions: PositionSummary[],
  nickname: string | null = null,
  maxPositions = 20,
): string {
  const label = nickname === null ? shortAddress(address) : `“${nickname}” (${shortAddress(address)})`;
  if (positions.length === 0) return `${label}: no active positions right now.`;

  const rank = (state: string): number => state === "OUT_OF_RANGE" ? 0 : state === "IN_RANGE" ? 1 : 2;
  const sorted = [...positions].sort((left, right) => rank(left.rangeState) - rank(right.rangeState));
  const lines = [`${label} — ${positions.length} position${positions.length === 1 ? "" : "s"}`];
  for (const position of sorted.slice(0, maxPositions)) {
    lines.push(`• ${position.chainLabel} · ${positionVenue(position.dex)} #${position.tokenId} · ${position.pair} · ${rangeLabel(position.rangeState)}`);
  }
  if (sorted.length > maxPositions) lines.push(`… +${sorted.length - maxPositions} more`);
  return lines.join("\n");
}

export function renderIncident(
  type: IncidentType,
  payload: Record<string, unknown>,
  nickname: string | null = null,
  options: { html?: boolean } = {},
): string {
  const regarding = nickname === null ? [] : [`For “${nickname}”:`, ""];

  if (type === "LP_OUT_OF_RANGE" || type === "LP_BACK_IN_RANGE") {
    const p = asRange(payload);
    const price = p.price ?? null;
    const values = priceValues(price);
    const html = options.html === true;
    const wallet = nickname ?? "Wallet";
    const address = p.owner ? shortAddress(p.owner) : null;
    const pair = price?.pairLabel ?? pairLabel(p.currency0, p.currency1);
    const chain = p.chainLabel ? ` · ${p.chainLabel}` : "";
    const arrow = price?.side === "ABOVE" ? "🔼" : price?.side === "BELOW" ? "🔽" : "";
    const header = html
      ? `🔔 <b>${escapeHtml(wallet)}</b>${address === null ? "" : ` (${escapeHtml(address)})`}${escapeHtml(chain)}`
      : `🔔 ${wallet}${address === null ? "" : ` (${address})`}${chain}`;
    const tone = type === "LP_OUT_OF_RANGE" ? "out of range 🚨" : "back in range ✅";
    const venue = `${venueIcon(p.dex)} ${venueLabel(p.dex)} ${tone} ${html ? escapeHtml(pair) : pair}`;
    const overview = [
      `Current Price: ${html ? escapeHtml(values.current) : values.current}${arrow === "" ? "" : ` ${arrow}`}`,
    ];
    if (price?.fullRange) {
      overview.push("Range: Full range");
    } else {
      overview.push(
        `Upper Price:   ${html ? escapeHtml(values.upper) : values.upper} ⎫`,
        `Lower Price:   ${html ? escapeHtml(values.lower) : values.lower} ⎭`,
      );
    }
    if (html) {
      return [
        header,
        "",
        venue,
        "",
        "<blockquote><b>Overview</b>",
        ...overview,
        "</blockquote>",
      ].join("\n");
    }
    return [header, "", venue, "", "Overview", ...overview].join("\n");
  }

  const p = asPositionChange(payload);
  const actions: Record<string, string> = {
    OPENED: "has been opened",
    INCREASED: "was increased",
    DECREASED: "was decreased",
    CLOSED: "has been closed",
    TRANSFERRED_IN: "was transferred into your wallet",
    TRANSFERRED_OUT: "was transferred out of your wallet",
    COLLECTED: "has had its fees collected",
  };
  const openings: Record<string, string> = {
    CLOSED: "One of your positions has been closed.",
    TRANSFERRED_IN: "A position just arrived at your address.",
    TRANSFERRED_OUT: "A position just left your address.",
    COLLECTED: "Fees were collected from one of your positions.",
  };
  const pair = p.symbol0 && p.symbol1
    ? `${p.symbol0} / ${p.symbol1}`
    : p.currency0 && p.currency1
      ? pairLabel(p.currency0, p.currency1)
      : p.poolRef;
  const lines = [
    openings[p.kind] ?? "Quick update on one of your positions.",
    "",
    ...regarding,
    `Your ${venueLabel(p.dex)} position #${p.tokenId} ${actions[p.kind] ?? "has changed"}.`,
    "",
    ...(p.chainLabel ? [`Chain: ${p.chainLabel}`] : []),
    `Pool: ${pair}`,
  ];
  if (typeof p.tickLower === "number" && typeof p.tickUpper === "number") {
    lines.push(`Ticks: [${p.tickLower}, ${p.tickUpper})`);
  }
  if (p.kind === "CLOSED") {
    lines.push("", "It's no longer active, so I'll stop watching it.");
  } else if (p.kind === "TRANSFERRED_OUT") {
    lines.push("", "It's no longer at this address, so I'll stop watching it here.");
  } else if (p.kind === "TRANSFERRED_IN") {
    lines.push("", "It's at this address now, so I'll keep an eye on it.");
  }
  if (p.explorerTxUrl) lines.push("", p.explorerTxUrl);
  lines.push("", "Your funds stay in your control — I only watch.");
  return lines.join("\n");
}

export const SAFETY_NOTE = "I'll never ask for your private key, seed phrase, or a signature. If you sent one by mistake, move any funds at risk and rotate your keys.";
