import postgres, { type Sql } from "postgres";
import type { DatabaseConfig } from "../config.js";

export type Database = Sql<Record<string, unknown>>;

/**
 * Postgres.js expands an absolute `host` directory to `.s.PGSQL.<port>` (its
 * `path` option instead expects the full socket filename), so a socket is passed
 * as `host`.
 */
export function createDatabase(config: DatabaseConfig, max = 10): Database {
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error("PostgreSQL max connections must be positive.");
  if (config.socketPath === null) return postgres(config.url, { max });
  if (!config.socketPath.startsWith("/") || config.socketPath.includes("\0")) {
    throw new Error("DATABASE_SOCKET_PATH must be an absolute filesystem path.");
  }
  return postgres(config.url, { max, host: config.socketPath });
}
