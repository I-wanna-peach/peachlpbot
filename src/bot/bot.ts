import { Bot } from "grammy";
import type { Store } from "../db/store.js";
import type { CommandDeps } from "./commands.js";
import { registerCommands } from "./commands.js";

export interface BotRuntimeDeps extends CommandDeps {
  botToken: string;
}

/**
 * grammY long-polling bot. Long polling is deliberate: the Seoul host exposes no
 * public HTTPS endpoint, so a webhook would need extra infrastructure, while the
 * Bot API poller needs only outbound access.
 *
 * `update_id` is recorded before handling so a replay is dropped. Message text is
 * never persisted; only the update identity and a coarse kind.
 */
export function createBot(deps: BotRuntimeDeps): Bot {
  const bot = new Bot(deps.botToken);

  bot.use(async (ctx, next) => {
    const kind = ctx.update.message ? "message" : "other";
    const chatId = ctx.chat === undefined ? "0" : String(ctx.chat.id);
    const fresh = await deps.store.recordTelegramUpdate(BigInt(ctx.update.update_id), chatId, kind);
    if (!fresh) return;
    await next();
  });

  registerCommands(bot, deps);

  bot.catch((error) => {
    // Never log the update body: it may contain user input.
    process.stderr.write(`telegram handler failed for update ${error.ctx.update.update_id}: ${error.message}\n`);
  });

  return bot;
}
