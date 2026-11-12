import type { Address } from "viem";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { ChainDescriptor } from "../chains.js";
import type { TelegramConfig } from "../config.js";
import type { Store } from "../db/store.js";
import type { OwnerDiscovery } from "../indexer/discover.js";
import type { TokenMetadataCache } from "../chain/token-metadata.js";
import { safeError } from "../util.js";
import { NICKNAME_MAX_LENGTH, normalizeNickname, parseCandidateAddress } from "./address.js";
import {
  PEACHBOT_INTRO,
  SAFETY_NOTE,
  pairLabel,
  positionsList,
  shortAddress,
  watchPrompt,
  watchResult,
  watchingList,
  type ChainDiscoverySummary,
  type PositionSummary,
} from "./persona.js";

export interface CommandDeps {
  store: Store;
  chains: readonly ChainDescriptor[];
  /** Keyed by `chainId.toString()`. */
  discoveries: ReadonlyMap<string, OwnerDiscovery>;
  /** Keyed by `chainId.toString()`. */
  tokens: ReadonlyMap<string, TokenMetadataCache>;
  telegram: TelegramConfig;
}

interface PendingNickname {
  address: Address;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const EMPTY_KEYBOARD = { inline_keyboard: [] };
const MAX_MESSAGE = 3_500;

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  const pending = new Map<string, PendingNickname>();

  async function discoverAll(address: Address): Promise<{ results: ChainDiscoverySummary[]; partial: boolean }> {
    const results = await Promise.all(deps.chains.map(async (chain): Promise<ChainDiscoverySummary & { partial: boolean }> => {
      const discovery = deps.discoveries.get(chain.chainId.toString());
      if (discovery === undefined) {
        return { label: chain.shortLabel, positions: null, error: true, partial: false };
      }
      try {
        const result = await discovery.discover(address);
        return { label: chain.shortLabel, positions: result.positions, error: false, partial: result.partial };
      } catch (error) {
        process.stderr.write(`${chain.key} discovery for a subscription failed: ${safeError(error)}\n`);
        return { label: chain.shortLabel, positions: null, error: true, partial: false };
      }
    }));
    return {
      results: results.map(({ label, positions, error }) => ({ label, positions, error })),
      partial: results.some((entry) => entry.partial),
    };
  }

  async function promptConfirmation(ctx: Context, address: Address): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const existing = await deps.store.findActiveSubscription(String(chatId), address);
    if (existing !== null) {
      await ctx.reply(existing.nickname === null
        ? "I'm already watching that address."
        : `I'm already watching it as “${existing.nickname}”.`);
      return;
    }
    const active = await deps.store.countActiveSubscriptions(String(chatId));
    if (active >= deps.telegram.maxSubscriptionsPerChat) {
      await ctx.reply(`I can watch up to ${deps.telegram.maxSubscriptionsPerChat} addresses at a time. Use /unwatch to free one up.`);
      return;
    }
    await ctx.reply(
      [
        `EVM address: ${shortAddress(address)}`,
        "",
        "Want me to watch it? I'll check its LP positions on Arc.",
      ].join("\n"),
      { reply_markup: new InlineKeyboard().text("✅ Yes", `confirm:${address}`).text("❌ No", "cancel") },
    );
  }

  async function completeNickname(ctx: Context, address: Address, raw: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const nickname = normalizeNickname(raw);
    if (nickname === null) {
      await ctx.reply(`Please send a name of 1–${NICKNAME_MAX_LENGTH} characters. /cancel to stop.`);
      return;
    }
    pending.delete(String(chatId));
    const active = await deps.store.countActiveSubscriptions(String(chatId));
    if (active >= deps.telegram.maxSubscriptionsPerChat) {
      await ctx.reply(`I can watch up to ${deps.telegram.maxSubscriptionsPerChat} addresses at a time. Use /unwatch to free one up.`);
      return;
    }
    const created = await deps.store.createSubscription(String(chatId), address, nickname);
    if (!created) {
      await ctx.reply("I'm already watching that address.");
      return;
    }
    const discovery = await discoverAll(address);
    const note = discovery.partial
      ? "\n\nStill catching up on older history — a few more positions may show up shortly."
      : "";
    await ctx.reply(`${watchResult(address, nickname, discovery.results)}${note}`);
  }

  bot.command("start", async (ctx) => {
    const keyboard = new InlineKeyboard();
    if (deps.telegram.communityGroupUrl) keyboard.url("Join the group", deps.telegram.communityGroupUrl);
    if (deps.telegram.communityXUrl) keyboard.url("Follow on X", deps.telegram.communityXUrl);
    const hasButtons = deps.telegram.communityGroupUrl !== null || deps.telegram.communityXUrl !== null;
    await ctx.reply(`${PEACHBOT_INTRO}\n\n${SAFETY_NOTE}`, hasButtons ? { reply_markup: keyboard } : undefined);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply([
      "PeachBot 🦔 — LP alerts for Arc.",
      "",
      "Send me an EVM address and I'll ask you to confirm it and give it a name.",
      "",
      "/watching — addresses I'm watching",
      "/positions — positions and range status",
      "/unwatch <address> — stop watching an address",
      "/cancel — stop the current confirmation",
      "/help — this list",
      "",
      SAFETY_NOTE,
    ].join("\n"));
  });

  bot.command("cancel", async (ctx) => {
    pending.delete(String(ctx.chat.id));
    await ctx.reply("Okay, cancelled.");
  });

  bot.command("watch", async (ctx) => {
    const address = parseCandidateAddress(ctx.match);
    if (address === null) {
      await ctx.reply("Please send a valid EVM address, e.g. /watch 0x1234…abcd");
      return;
    }
    await promptConfirmation(ctx, address);
  });

  bot.command("watching", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const subscriptions = await deps.store.listSubscriptions(chatId);
    const rows: { nickname: string | null; watchedAddress: string; positions: number }[] = [];
    for (const subscription of subscriptions) {
      let positions = 0;
      for (const chain of deps.chains) {
        const owned = await deps.store.findPositionsByOwner(chain.chainId, subscription.watchedAddress);
        positions += owned.filter((position) => position.status === "ACTIVE").length;
      }
      rows.push({
        nickname: subscription.nickname,
        watchedAddress: subscription.watchedAddress,
        positions,
      });
    }
    await ctx.reply(watchingList(rows));
  });

  bot.command("positions", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const subscriptions = await deps.store.listSubscriptions(chatId);
    if (subscriptions.length === 0) {
      await ctx.reply("You're not watching any addresses yet. Send me one to get started.");
      return;
    }

    const blocks: string[] = [];
    for (const subscription of subscriptions) {
      const summaries: PositionSummary[] = [];
      for (const chain of deps.chains) {
        const owned = (await deps.store.findPositionsByOwner(chain.chainId, subscription.watchedAddress))
          .filter((position) => position.status === "ACTIVE");
        if (owned.length === 0) continue;

        const metadata = deps.tokens.get(chain.chainId.toString());
        let symbols = new Map<string, { symbol: string; decimals: number }>();
        if (metadata !== undefined) {
          const currencies = [...new Set(owned.flatMap((position) => [position.currency0, position.currency1]))];
          try {
            symbols = await metadata.get(currencies);
          } catch {
            // Symbols are decorative; fall back to short addresses.
          }
        }

        for (const position of owned) {
          const symbol0 = symbols.get(position.currency0.toLowerCase())?.symbol;
          const symbol1 = symbols.get(position.currency1.toLowerCase())?.symbol;
          summaries.push({
            chainLabel: chain.shortLabel,
            dex: position.dex,
            tokenId: position.tokenId.toString(),
            pair: symbol0 && symbol1 ? `${symbol0} / ${symbol1}` : pairLabel(position.currency0, position.currency1),
            rangeState: position.rangeState,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
          });
        }
      }
      blocks.push(positionsList(subscription.watchedAddress, summaries, subscription.nickname));
    }

    // Keep the whole reply under Telegram's 4096-character limit.
    let message = "";
    let omitted = 0;
    for (const block of blocks) {
      const next = message.length === 0 ? block : `${message}\n\n${block}`;
      if (next.length > MAX_MESSAGE) {
        omitted += 1;
        continue;
      }
      message = next;
    }
    if (omitted > 0) message += `\n\n… ${omitted} more address${omitted === 1 ? "" : "es"} omitted.`;
    await ctx.reply(message);
  });

  bot.command("unwatch", async (ctx) => {
    const address = parseCandidateAddress(ctx.match);
    if (address === null) {
      await ctx.reply("Send the address you want me to stop watching, e.g. /unwatch 0x1234…abcd");
      return;
    }
    const removed = await deps.store.revokeSubscription(String(ctx.chat.id), address);
    await ctx.reply(removed
      ? `Done — I've stopped watching ${shortAddress(address)}.`
      : "I wasn't watching that address.");
  });

  bot.callbackQuery(/^confirm:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    const raw = ctx.match[1];
    if (chatId === undefined || raw === undefined) return;
    const address = parseCandidateAddress(raw);
    if (address === null) return;
    const existing = await deps.store.findActiveSubscription(String(chatId), address);
    if (existing !== null) {
      await ctx.reply(existing.nickname === null
        ? "I'm already watching that address."
        : `I'm already watching it as “${existing.nickname}”.`);
      return;
    }
    pending.set(String(chatId), { address, expiresAt: Date.now() + PENDING_TTL_MS });
    await ctx.editMessageReplyMarkup({ reply_markup: EMPTY_KEYBOARD }).catch(() => {});
    await ctx.reply(`Nice. What should I call ${shortAddress(address)}? Send a name (1–${NICKNAME_MAX_LENGTH} characters) or /cancel.`);
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) pending.delete(String(chatId));
    await ctx.editMessageReplyMarkup({ reply_markup: EMPTY_KEYBOARD }).catch(() => {});
    await ctx.reply("Okay, cancelled.");
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const chatId = String(ctx.chat.id);
    if (/^(0x)?[0-9a-fA-F]{64,}$/.test(text) || /private key|seed phrase|mnemonic|助记词|私钥/i.test(text)) {
      await ctx.reply("That looks like a private key or seed phrase. I won't read or repeat it. Please delete it, move any funds at risk, and rotate your keys.");
      return;
    }
    const address = parseCandidateAddress(text);
    if (address !== null) {
      await promptConfirmation(ctx, address);
      return;
    }
    const state = pending.get(chatId);
    if (state !== undefined) {
      if (state.expiresAt > Date.now()) {
        await completeNickname(ctx, state.address, text);
        return;
      }
      pending.delete(chatId);
    }
    await ctx.reply("Hi — I'm PeachBot 🦔. Send me an EVM address to get started, or /help for the command list.");
  });
}
