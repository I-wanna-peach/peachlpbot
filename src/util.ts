/** Error text safe to log or show: never echo an RPC URL (it carries the API key). */
export function safeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, "[rpc]")
    .replace(/[a-f0-9]{32,}/gi, "[redacted]");
}
