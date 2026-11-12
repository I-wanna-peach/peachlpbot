import {
  loadChainConfigs,
  loadDatabaseConfig,
  loadMonitorConfig,
  loadTelegramConfig,
  type ChainConfig,
} from "./config.js";
import { createDatabase } from "./db/client.js";
import { Store } from "./db/store.js";
import { createChainClient, type ChainClient } from "./rpc.js";
import { PositionRefresher } from "./indexer/refresh.js";
import { OwnerDiscovery } from "./indexer/discover.js";
import { PositionIndexer } from "./indexer/position-indexer.js";
import { TickMonitor } from "./monitor/tick-monitor.js";
import { TokenMetadataCache } from "./chain/token-metadata.js";
import { createBot } from "./bot/bot.js";
import { DeliveryWorker } from "./delivery/worker.js";
import { safeError } from "./util.js";

const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice("--only=".length) ?? null;
if (only !== null && !["index", "monitor", "bot"].includes(only)) {
  throw new Error(`Unknown --only=${only}; expected index, monitor or bot.`);
}
const runIndexer = only === null || only === "index";
const runMonitor = only === null || only === "monitor";
const runTelegram = only === null || only === "bot";

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} [peachlpbot] ${message}\n`);
}

const SLEEP_GRANULARITY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stopping = false;

async function loop(name: string, intervalMs: number, run: () => Promise<void>): Promise<void> {
  while (!stopping) {
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} [peachlpbot] ${name} failed: ${safeError(error)}\n`);
    }
    const elapsed = Date.now() - started;
    const wait = Math.max(0, intervalMs - elapsed);
    // sleep in small slices so a shutdown signal is noticed promptly
    for (let slept = 0; slept < wait && !stopping; slept += SLEEP_GRANULARITY_MS) {
      await sleep(Math.min(SLEEP_GRANULARITY_MS, wait - slept));
    }
  }
}

const chainConfigs = loadChainConfigs();
const monitorConfig = loadMonitorConfig();
const sql = createDatabase(loadDatabaseConfig());
const store = new Store(sql);

interface ChainContext {
  config: ChainConfig;
  client: ChainClient;
  refresher: PositionRefresher;
  tokens: TokenMetadataCache;
  discovery: OwnerDiscovery;
}

const contexts: ChainContext[] = chainConfigs.map((config) => {
  const client = createChainClient({
    chain: config.descriptor,
    rpcUrl: config.rpcUrl,
    chunkSize: config.indexer.chunkSize,
  });
  const refresher = new PositionRefresher({ client, store, chain: config.descriptor });
  const tokens = new TokenMetadataCache({ store, client, chain: config.descriptor });
  const discovery = new OwnerDiscovery({ client, store, refresher, chain: config.descriptor, config });
  return { config, client, refresher, tokens, discovery };
});

const contextByChainId = new Map(contexts.map((context) => [context.config.descriptor.chainId.toString(), context] as const));
const loops: Promise<void>[] = [];

for (const context of contexts) {
  const { config, client, refresher, tokens, discovery } = context;
  const chain = config.descriptor;

  if (runIndexer) {
    const indexer = new PositionIndexer({ client, store, refresher, config, chain, tokens });
    let cycles = 0;
    loops.push(loop(`indexer:${chain.key}`, config.pollIntervalMs, async () => {
      const result = await indexer.runOnce();
      cycles += 1;
      // Safety net for state changes that emit no event the indexer watches.
      if (cycles % 15 === 0) {
        const swept = await indexer.sweepWatchedOwners();
        if (swept > 0) log(`${chain.key} re-materialized ${swept} watched positions`);
      }
      if (result.processedChunks > 0) {
        log(`${chain.key} indexed chunks=${result.processedChunks} atHead=${result.atHead} refreshedOwners=${result.refreshedOwners}`);
      }
    }));

    // v3 ownership is discovered per address (ERC721Enumerable); v4 uses the
    // transfer index. Re-run discovery so newly watched venues appear without
    // another /watch, and so stale rows self-heal.
    loops.push(loop(`discovery:${chain.key}`, 1_800_000, async () => {
      const owners = await store.watchedAddresses();
      let found = 0;
      let failed = 0;
      for (const owner of owners) {
        try {
          const result = await discovery.discover(owner);
          found += result.positions;
        } catch {
          failed += 1;
        }
      }
      if (found > 0 || failed > 0) {
        log(`${chain.key} discovery refreshed ${found} positions across ${owners.length} addresses (failed=${failed})`);
      }
    }));
  }

  if (runMonitor) {
    const monitor = new TickMonitor({ client, store, chain, config: monitorConfig, tokens });
    loops.push(loop(`monitor:${chain.key}`, config.pollIntervalMs, async () => {
      const result = await monitor.runOnce();
      if (result.incidents > 0) {
        log(`${chain.key} range incidents=${result.incidents} pools=${result.poolsRead} positions=${result.positionsEvaluated}`);
      }
    }));
  }
}

const telegramConfig = runTelegram ? loadTelegramConfig() : null;

if (telegramConfig !== null) {
  const discoveries = new Map<string, OwnerDiscovery>();
  const tokens = new Map<string, TokenMetadataCache>();
  for (const context of contexts) {
    const key = context.config.descriptor.chainId.toString();
    discoveries.set(key, context.discovery);
    tokens.set(key, context.tokens);
  }

  const bot = createBot({
    botToken: telegramConfig.botToken,
    store,
    chains: chainConfigs.map((config) => config.descriptor),
    discoveries,
    tokens,
    telegram: telegramConfig,
  });
  const worker = new DeliveryWorker({
    store,
    bot,
    maxAttempts: 6,
    batchSize: 20,
  });
  loops.push(loop("delivery", 2_000, async () => {
    const result = await worker.runOnce();
    if (result.sent > 0 || result.retried > 0 || result.failed > 0) {
      log(`delivery sent=${result.sent} retried=${result.retried} failed=${result.failed}`);
    }
  }));
  void bot.start({
    onStart: (info) => log(`telegram bot @${info.username} started (long polling)`),
  });
}

log(`started mode=${only ?? "all"} chains=${chainConfigs.map((config) => `${config.descriptor.key}:${config.descriptor.chainId}`).join(",")} contexts=${contextByChainId.size}`);

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}, shutting down`);
  await Promise.race([Promise.allSettled(loops), sleep(5_000)]);
  await store.close();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
