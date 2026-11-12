import type { Bot } from "grammy";
import type { Store } from "../db/store.js";
import type { IncidentType } from "../types.js";
import { renderIncident } from "../bot/persona.js";
import { classify } from "./classify.js";

export interface DeliveryDeps {
  store: Store;
  bot: Bot;
  maxAttempts: number;
  batchSize: number;
  now?: () => Date;
}

/**
 * Transactional-outbox delivery loop. Claims a bounded batch, sends each queued
 * incident, and records the outcome. A Telegram timeout is an UNKNOWN result, so
 * it is retried through the same delivery row rather than creating a new
 * incident; only a permanent chat error ends in FAILED_FINAL.
 */
export class DeliveryWorker {
  readonly #deps: DeliveryDeps;

  constructor(deps: DeliveryDeps) {
    this.#deps = deps;
  }

  async runOnce(): Promise<{ sent: number; retried: number; failed: number }> {
    const due = await this.#deps.store.claimDueDeliveries(this.#deps.batchSize);
    let sent = 0;
    let retried = 0;
    let failed = 0;
    for (const delivery of due) {
      const html = delivery.type === "LP_OUT_OF_RANGE" || delivery.type === "LP_BACK_IN_RANGE";
      let text: string;
      try {
        text = renderIncident(delivery.type as IncidentType, delivery.payload, delivery.nickname, { html });
      } catch {
        // A malformed payload cannot be fixed by retrying; don't wedge the outbox.
        await this.#deps.store.markFailedFinal(delivery.id, "RENDER_ERROR");
        failed += 1;
        continue;
      }
      try {
        const message = await this.#deps.bot.api.sendMessage(delivery.telegramChatId, text, html
          ? { parse_mode: "HTML", link_preview_options: { is_disabled: false } }
          : { link_preview_options: { is_disabled: false } });
        await this.#deps.store.markDelivered(delivery.id, BigInt(message.message_id));
        sent += 1;
      } catch (error) {
        const classification = classify(error, delivery.attempts + 1, this.#deps.maxAttempts);
        if (classification.kind === "retry") {
          const base = this.#deps.now?.() ?? new Date();
          await this.#deps.store.markRetry(delivery.id, new Date(base.getTime() + classification.delayMs), classification.errorClass);
          retried += 1;
        } else {
          await this.#deps.store.markFailedFinal(delivery.id, classification.errorClass);
          failed += 1;
        }
      }
    }
    return { sent, retried, failed };
  }
}
