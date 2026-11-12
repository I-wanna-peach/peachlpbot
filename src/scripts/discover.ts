import { getAddress } from "viem";
import { loadChainConfigs, loadDatabaseConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { Store } from "../db/store.js";
import { createChainClient } from "../rpc.js";
import { PositionRefresher } from "../indexer/refresh.js";
import { OwnerDiscovery } from "../indexer/discover.js";
import { TokenMetadataCache } from "../chain/token-metadata.js";
import { parseCandidateAddress } from "../bot/address.js";
import { safeError } from "../util.js";

/**
 * Ops helper: discover an address on every enabled chain and print what the bot
 * would see. Writes the same rows a real subscription would, but does not create
 * a subscription.
 *
 *   bun run discover 0x…
 */

const raw = process.argv[2];
const address = raw === undefined ? null : parseCandidateAddress(raw);
if (address === null) {
  process.stderr.write("usage: bun run discover 0x<40 hex>\n");
  process.exit(2);
}

const sql = createDatabase(loadDatabaseConfig(), 2);
const store = new Store(sql);

try {
  for (const config of loadChainConfigs()) {
    const chain = config.descriptor;
    const client = createChainClient({ chain, rpcUrl: config.rpcUrl, chunkSize: config.indexer.chunkSize });
    const refresher = new PositionRefresher({ client, store, chain });
    const tokens = new TokenMetadataCache({ store, client, chain });
    const discovery = new OwnerDiscovery({ client, store, refresher, chain, config });

    const head = await client.getBlockNumber();
    const cursor = await store.getCursor(chain.chainId, "positions");
    process.stdout.write(`\n=== ${chain.name} (${chain.key}) head=${head} v4IndexLag=${cursor === null ? "not started" : (head - cursor.lastBlock).toString()} ===\n`);
    try {
      const result = await discovery.discover(address);
      process.stdout.write(`  positions=${result.positions} partial=${result.partial}\n`);
      const positions = await store.findPositionsByOwner(chain.chainId, getAddress(address));
      for (const position of positions) {
        const metadata = await tokens.get([position.currency0, position.currency1]).catch(() => new Map());
        const symbol0 = metadata.get(position.currency0.toLowerCase())?.symbol ?? position.currency0;
        const symbol1 = metadata.get(position.currency1.toLowerCase())?.symbol ?? position.currency1;
        process.stdout.write(`  · ${position.dex} #${position.tokenId} ${symbol0}/${symbol1} ticks=[${position.tickLower}, ${position.tickUpper}) liquidity=${position.liquidity} status=${position.status} range=${position.rangeState}\n`);
      }
    } catch (error) {
      process.stdout.write(`  discovery failed: ${safeError(error)}\n`);
    }
  }
} finally {
  await store.close();
}
