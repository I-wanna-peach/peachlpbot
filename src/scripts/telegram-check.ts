import { loadTelegramConfig } from "../config.js";

/**
 * Verifies a Telegram bot token without starting the poller.
 *
 *   TELEGRAM_BOT_TOKEN=... bun run bot:check
 *   TELEGRAM_BOT_TOKEN=... bun run bot:check --chat 123456789
 *
 * `--chat` sends one test message so delivery can be confirmed before the full
 * service is deployed. The token is never printed.
 */

const config = loadTelegramConfig();

async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { ok?: boolean; result?: T; description?: string };
  if (payload.ok !== true) throw new Error(`${method} failed: ${payload.description ?? `HTTP ${response.status}`}`);
  return payload.result as T;
}

const me = await call<{ id: number; username?: string; first_name: string }>("getMe");
process.stdout.write(`token valid: @${me.username ?? me.first_name} (id ${me.id})\n`);

const chatIndex = process.argv.indexOf("--chat");
const chat = chatIndex === -1 ? null : process.argv[chatIndex + 1] ?? null;
if (chat !== null) {
  const message = await call<{ message_id: number }>("sendMessage", {
    chat_id: chat,
    text: "PeachBot here 🦔 — token and delivery path are working.",
    link_preview_options: { is_disabled: true },
  });
  process.stdout.write(`test message delivered to chat ${chat} (message ${message.message_id})\n`);
}
