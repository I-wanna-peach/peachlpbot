# AGENTS.md — peachlpbot

**Read first.** This project is a two-chain port of `../unilpbot`.

## Runtime and host

- Production: `ssh seoul` (`VM-0-13-ubuntu`, Ubuntu 24.04.4), run as the system
  user `peach` (home `/var/lib/peach`, nologin).
- Bun: `/usr/local/bin/bun` (1.4.2 on the host), but that is a symlink into
  `/home/arc` and the unit runs with `ProtectHome=true`. The service executes a
  real copy at `/opt/peachlpbot/bin/bun`, refreshed by `deploy/deploy.sh`.
  Never use Node as the entry.
- PostgreSQL 16.15 on `127.0.0.1:5432`, database `peachlpbot`, role `peach`.
- Code `/opt/peachlpbot/current`; config `/etc/peachlpbot/env` (`root:peach`,
  `0640`); unit `peachlpbot.service`.
- RPC endpoints are IP-whitelisted for this host only:
  `BSC_RPC_URL` (chain 56) and `ARC_RPC_URL` (chain 5042). They will not answer
  from a laptop, so live loops and `bun run probe` run on the server.
- Telegram uses **long polling**; no inbound port is opened.

## Commands

```sh
bun run build      # tsc --noEmit
bun test test/*.test.ts
bun run migrate
bun run probe      # read-only venue/RPC/eth_getLogs verification (server only)
bun run start      # every loop
bun run index | monitor | bot
```

## Conventions

- **All chain addresses live in `src/chains.ts`.** Never re-hardcode an address
  in an indexer, monitor or bot module.
- Addresses/hashes are `bytea`, large integers `numeric(78,0)`; read them with
  `src/bytes.ts`.
- Invariants belong in DB CHECK constraints, not only in application code.
- Unknown is never coerced: a pool tick that cannot be read produces no range
  conclusion; missing token metadata produces no price.
- Subscriptions are chain-agnostic (`watched_address` only). Positions, pools,
  incidents and cursors carry `chain_id`.
- `dex` disambiguates venues whose token ids collide (Uniswap and PancakeSwap
  both start at 1 on BSC). Primary keys are `(chain_id, dex, token_id)`.
- Never log RPC URLs (they contain the API key), Telegram tokens, or message
  bodies. Use `safeError()` in `src/util.ts` for anything user-visible.
- Arc: native USDC is 18 dp, ERC-20 USDC (`0x3600…0000`) is 6 dp over the same
  balance. The `UnsupportedProtocol` address is not a token.
- Migrations are idempotent and replay on every `bun run migrate`.

## Deploy

`deploy/bootstrap.sh` (once, as root) then `deploy/deploy.sh` (per release).
See `deploy/README.md`.
