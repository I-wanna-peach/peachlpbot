import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDatabaseConfig } from "../config.js";
import { createDatabase } from "./client.js";

/**
 * Applies every `migrations/*.sql` in filename order. The DDL is idempotent
 * (`IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`), so replaying all files on
 * every run is safe and an interrupted run can simply be re-run. Each file
 * executes as one simple-protocol batch so the file's statements keep their
 * written order.
 */
export async function migrate(): Promise<void> {
  const sql = createDatabase(loadDatabaseConfig(), 1);
  try {
    const directory = new URL("../../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      const content = await readFile(join(directory.pathname, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(content).simple();
      });
      process.stdout.write(`applied ${file}\n`);
    }
  } finally {
    await sql.end();
  }
}

await (import.meta.main ? migrate() : Promise.resolve());
