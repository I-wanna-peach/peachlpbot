import { GrammyError, HttpError } from "grammy";

export type Classification =
  | { kind: "retry"; delayMs: number; errorClass: string }
  | { kind: "final"; errorClass: string };

/**
 * Shared Telegram retry policy. A timeout is an UNKNOWN result and is retried; a
 * blocked chat or a rejected message is permanent.
 */
export function classify(error: unknown, attempts: number, maxAttempts: number): Classification {
  if (error instanceof GrammyError) {
    const code = error.error_code;
    const retryAfter = error.parameters?.retry_after;
    if (code === 429) {
      const delayMs = (retryAfter ?? 1) * 1_000;
      return attempts >= maxAttempts ? { kind: "final", errorClass: "RATE_LIMITED" } : { kind: "retry", delayMs, errorClass: "RATE_LIMITED" };
    }
    if (code === 403 || code === 400) return { kind: "final", errorClass: `TELEGRAM_${code}` };
    if (code >= 500) return retry(attempts, maxAttempts, "TELEGRAM_5XX");
    return { kind: "final", errorClass: `TELEGRAM_${code}` };
  }
  if (error instanceof HttpError) return retry(attempts, maxAttempts, "TELEGRAM_NETWORK");
  return retry(attempts, maxAttempts, "UNKNOWN");
}

function retry(attempts: number, maxAttempts: number, errorClass: string): Classification {
  if (attempts >= maxAttempts) return { kind: "final", errorClass };
  return { kind: "retry", delayMs: Math.min(2 ** attempts * 1_000, 60_000), errorClass };
}
