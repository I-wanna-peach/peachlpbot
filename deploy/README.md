# Production deployment (Seoul)

Actual state as of 2026-10-22. Host reached as `ssh seoul`.

Current release: `/opt/peachlpbot/releases/20261022-r1`, bot **@peachdefibot**.

## Host facts

| Item | Value |
| --- | --- |
| Host | `VM-0-13-ubuntu`, Ubuntu 24.04.4 LTS, x86_64 |
| Bun | `/usr/local/bin/bun` 1.4.2 |
| PostgreSQL | 16.15, `127.0.0.1:5432`, accepting connections |
| Chain RPC | BSC + Arc QuickNode endpoints, IP-whitelisted to this host |
| Telegram | long polling (no inbound port) |

### Bun path

`/usr/local/bin/bun` is a symlink to `/home/arc/.bun/bin/bun`. `ProtectHome=true`
hides `/home`, so the unit executes a real copy at `/opt/peachlpbot/bin/bun`
(refreshed by `deploy.sh` from the symlink target). Do not point `ExecStart` at
`/usr/local/bin/bun` directly: systemd fails with `203/EXEC`.

### Telegram egress (IPv4)

`api.telegram.org` resolves to an IPv6 address first on this host, and that route
does not work, so Bun's fetch hangs until its timeout. The unit therefore sets
`NODE_OPTIONS=--dns-result-order=ipv4first`. Use `curl -4` when testing by hand.


## Account and paths

| Item | Value |
| --- | --- |
| System user | `peach` (home `/var/lib/peach`, nologin) |
| Code | `/opt/peachlpbot/releases/<release>`, `/opt/peachlpbot/current` symlink |
| Config/secrets | `/etc/peachlpbot/env` (`root:peach`, `0640`) |
| Service | `peachlpbot.service` |
| Database | role `peach` / database `peachlpbot` |

## First install (once, as root)

```sh
cd /opt/peachlpbot/releases/<release>
BSC_RPC_URL='https://…bsc…/' \
ARC_RPC_URL='https://…arc-mainnet…/' \
TELEGRAM_BOT_TOKEN='…' \
  bash deploy/bootstrap.sh
```

`bootstrap.sh` creates the `peach` user and `/var/lib/peach`, generates a
database password, creates role + database, and writes `/etc/peachlpbot/env`
(only if it does not already exist). It never prints the password.

Then verify the endpoints *from the host* before starting anything:

```sh
set -a; . /etc/peachlpbot/env; set +a
for u in "$BSC_RPC_URL" "$ARC_RPC_URL"; do
  curl -sS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$u"; echo
done
# expect 0x38 (56) and 0x13b2 (5042)
```

## Release

```sh
RELEASE=20261022-r1 bash deploy/deploy.sh
```

The script rsyncs the tree (without `node_modules`, `.env`, `.git`, `test`),
installs production dependencies, installs the unit, migrates, and restarts.

## Probe (read-only, before trusting the loops)

```sh
ssh seoul 'set -a; . /etc/peachlpbot/env; set +a; cd /opt/peachlpbot/current && bun run probe'
```

Expect: correct chain ids, code at every venue, ERC721Enumerable proof, a
decodable `positions()` sample, working v4 reads, and the largest accepted
`eth_getLogs` range. If a range below the configured `*_LOG_CHUNK_SIZE` is
rejected, lower that variable in `/etc/peachlpbot/env` and restart.

## Verify

```sh
systemctl status peachlpbot.service
journalctl -u peachlpbot.service -n 100 --no-pager

ssh seoul 'set -a; . /etc/peachlpbot/env; set +a; psql "$DATABASE_URL" -c "
  select chain_id, dex, range_state, count(*) from positions group by 1,2,3 order by 1,2;
  select chain_id, stream, last_block, updated_at from indexer_cursors order by 1,2;
  select status, count(*) from deliveries group by 1"'
```

Telegram:

```sh
ssh seoul 'set -a; . /etc/peachlpbot/env; set +a; cd /opt/peachlpbot/current && bun run bot:check --chat <chat_id>'
```

End-to-end: `/start` → send an address holding positions on BSC and/or Arc →
confirm → nickname → `/positions` shows chain-labelled rows → `/watching` →
`/unwatch`.

## Rollback

```sh
ssh seoul 'ln -sfn /opt/peachlpbot/releases/<previous> /opt/peachlpbot/current && systemctl restart peachlpbot.service'
```

## Secrets

`/etc/peachlpbot/env` holds the QuickNode URLs (which embed the API key) and the
Telegram token. It is never committed. Rotate the QuickNode key if it has been
shared outside the host; after rotation update the env file and restart.
