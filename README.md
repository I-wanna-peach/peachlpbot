# peachlpbot

Telegram LP watchdog for **Arc (5042)**. A chat sends an EVM address; the bot
inventories that address's Uniswap V3 and Uniswap V4 liquidity positions on Arc
and alerts when a position leaves its price range, returns, or changes (opened /
increased / decreased / closed / collected / transferred).

Watch-only by construction: no private keys, no signatures, no approvals, no
transactions. The bot reads public on-chain state and sends messages.

## Venues

| Chain | Venues |
| --- | --- |
| Arc (5042) | Uniswap V3, Uniswap V4 |

All addresses live in one place: [`src/chains.ts`](src/chains.ts). Adding an
Arc fork (AchSwap/Sushi/Synthra/UnitFlow) is a single `v3Venues` entry.

Arc notes that matter:
- Gas is native USDC at 18 decimals. The ERC-20 USDC interface at
  `0x3600…0000` is 6 decimals over the *same* balance. Never mix them.
- `0x8bcE…937f` is Uniswap's `UnsupportedProtocol` WETH placeholder, not a token.
- Blocks are ~0.5 s and finality is deterministic (Malachite BFT).

## How it works

```
Arc
  PositionIndexer ── near-head events + v4 Transfer backfill ──> position_owners
        │                                                              │
        └── dirty owners ──> PositionRefresher (head read) ──> positions / pools
  OwnerDiscovery ── ERC721Enumerable (v3) + recipient-topic scan (v4)
  TickMonitor ── pool slot0 per round ──> debounced range state ──> incidents
                                                              │
global                                                        v
  grammY bot (long polling)  <──  DeliveryWorker  <──  deliveries (outbox)
```

- **Discovery.** V3 position managers are ERC-721 Enumerable, so a subscription
  enumerates `balanceOf` → `tokenOfOwnerByIndex` → `positions()` at head. V4 is
  not enumerable, so it uses a `Transfer` index (`position_owners`) plus a
  bounded recipient-topic scan and `ownerOf` verification.
- **Materialization.** Tick ranges and liquidity are read at a pinned head block
  (`positions()`, `getPoolAndPositionInfo`), never reconstructed from history, so
  a reorg self-heals on the next read.
- **Range semantics.** `tickLower <= tick < tickUpper` (upper bound exclusive).
  Out-of-range needs 2 distinct blocks, back-in-range 3; one sustained move
  produces one alert. Unknown tick (RPC failure, uninitialized pool) produces no
  conclusion.
- **Position changes.** V3 `IncreaseLiquidity` / `DecreaseLiquidity` / `Collect`,
  V4 `ModifyLiquidity` (zero delta = collect) and ERC-721 `Transfer`. Several
  logs in one transaction merge into one notice.
- **Delivery.** Incidents and their per-chat fan-out are written in one
  transaction (transactional outbox), then sent with retries. A revoked
  subscription has its queued deliveries cancelled.

## Commands

| Command | Meaning |
| --- | --- |
| *(send an address)* | Validate → confirm inline → nickname → discover on Arc |
| `/watching` | Watched addresses and their active position count |
| `/positions` | Active positions, out-of-range first, labelled ARC |
| `/unwatch <address>` | Remove the address and cancel queued alerts |
| `/cancel` | Abandon the address being confirmed |
| `/help` | Command list |

Nicknames are 1–32 characters.

## Run

Requires Bun ≥ 1.3 and PostgreSQL. The RPC endpoint is IP-whitelisted for the
Seoul host, so local development can run the tests but not the live loops.

```sh
cp .env.example .env        # RPC URL, DATABASE_URL, TELEGRAM_BOT_TOKEN
bun install
bun run migrate
bun run probe               # read-only venue / RPC / eth_getLogs verification
bun run start               # index + monitor + bot + delivery in one process
```

Split processes (optional):

```sh
bun run index               # ownership + discovery + event indexer
bun run monitor             # tick monitor only
bun run bot                 # Telegram poller + delivery worker
```

Checks:

```sh
bun run build               # tsc --noEmit
bun test test/*.test.ts     # pure-function tests, no database or RPC
bun run bot:check           # token validity
bun run bot:check --chat <id>  # one test message
bun run discover 0x…        # ops: what the bot would see for an address
```

## Configuration

`ARC_<VAR>` overrides the global `<VAR>`; a missing override inherits the global
value, then the default from `src/chains.ts`.

| Variable | Meaning |
| --- | --- |
| `ARC_RPC_URL` | Required HTTP endpoint |
| `DATABASE_URL` | `postgres://peach:…@127.0.0.1:5432/peachlpbot` |
| `TELEGRAM_BOT_TOKEN` | BotFather token (long polling, no inbound port) |
| `ARC_LOG_CHUNK_SIZE` | `eth_getLogs` block range (probe measures the ceiling) |
| `ARC_LOOKBACK_BLOCKS` | First-run backfill window (V4 ownership) |
| `ARC_INDEXER_START_BLOCK` | Pin the first block instead of deriving it |
| `ARC_MAX_CHUNKS_PER_RUN` | Backfill pace per indexer cycle |
| `ARC_POLL_INTERVAL_MS` | Indexer + monitor cadence |
| `OUT_OF_RANGE_CONFIRM_BLOCKS` / `IN_RANGE_CONFIRM_BLOCKS` | Debounce |
| `NOTIFY_BACK_IN_RANGE` | Default `false`: state updates, no message |
| `MAX_SUBSCRIPTIONS_PER_CHAT` | Default 20 |
| `INDEXER_TAIL_WINDOW_BLOCKS` | Blocks near head that also pull liquidity events |

## Database

One database, all tables keyed by `chain_id`: `position_owners`, `positions`,
`pools`, `subscriptions`, `incidents`, `deliveries`, `position_events`,
`indexer_cursors`, `tokens`, `telegram_updates`, plus the
`v_pool_position_subscriber` view. Invariants are CHECK constraints
(`tick_lower < tick_upper`, tick alignment, `status='CLOSED' ⇔ liquidity=0`).

## Deployment

See [`deploy/README.md`](deploy/README.md). The production unit runs as the
system user `peach`, code in `/opt/peachlpbot/current`, secrets in
`/etc/peachlpbot/env` (`root:peach 0640`), service `peachlpbot.service`.

## Known limitations

- **V4 history window.** The v4 PositionManager is not enumerable. Positions
  minted before `ARC_INDEXER_START_BLOCK` / the lookback window are only found
  once the ownership backfill cursor reaches them. V3 is unaffected (enumerable
  at head). The subscribe reply says when discovery is still partial.
- **`eth_getLogs` limits are plan-dependent.** Chunk sizes are configurable;
  `bun run probe` measures what the endpoint actually accepts.
- **Collect is a heuristic** on V4 (`ModifyLiquidity` with `liquidityDelta = 0`).
- **Prices are relative** (quote per base, using Arc's quote preference), not
  USD. Missing token metadata means ticks only, never a fabricated price.
- **Reorgs.** V4 ownership rewind is bounded (`ARC_REORG_REWIND`). Arc has
  deterministic finality.
- **In-memory confirmation state** (pending nickname, 10 min TTL) is lost on
  restart; subscriptions and alerts are in Postgres.
