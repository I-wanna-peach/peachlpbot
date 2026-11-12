#!/usr/bin/env bash
# One-time server bootstrap. Run as root on the host (`ssh seoul`).
#
#   BSC_RPC_URL=... ARC_RPC_URL=... TELEGRAM_BOT_TOKEN=... \
#     bash deploy/bootstrap.sh
#
# Idempotent: existing users, directories, role, database and env file are kept.
set -euo pipefail

if ! id -u peach >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/peach --create-home --shell /usr/sbin/nologin peach
fi

install -d -o root -g peach -m 0750 /opt/peachlpbot /opt/peachlpbot/releases /etc/peachlpbot
install -d -o peach -g peach -m 0750 /var/lib/peach

# --- database ---------------------------------------------------------------
DB_PASSWORD="${PEACH_DB_PASSWORD:-}"
if [ -z "$DB_PASSWORD" ] && [ -f /etc/peachlpbot/env ]; then
  DB_PASSWORD="$(sed -n 's#^DATABASE_URL=postgres://peach:\([^@]*\)@.*#\1#p' /etc/peachlpbot/env | head -1)"
fi
if [ -z "$DB_PASSWORD" ]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='peach'" | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE peach LOGIN PASSWORD '$DB_PASSWORD'"
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE peach WITH PASSWORD '$DB_PASSWORD'"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='peachlpbot'" | grep -q 1; then
  sudo -u postgres createdb -O peach peachlpbot
fi

# --- configuration ----------------------------------------------------------
if [ ! -f /etc/peachlpbot/env ]; then
  : "${BSC_RPC_URL:?BSC_RPC_URL is required to create /etc/peachlpbot/env}"
  : "${ARC_RPC_URL:?ARC_RPC_URL is required to create /etc/peachlpbot/env}"
  cat > /etc/peachlpbot/env <<EOF
CHAINS=bsc,arc
BSC_RPC_URL=${BSC_RPC_URL}
ARC_RPC_URL=${ARC_RPC_URL}
DATABASE_URL=postgres://peach:${DB_PASSWORD}@127.0.0.1:5432/peachlpbot
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
MAX_SUBSCRIPTIONS_PER_CHAT=20
BSC_LOG_CHUNK_SIZE=5000
BSC_LOOKBACK_BLOCKS=5000000
BSC_MAX_CHUNKS_PER_RUN=50
BSC_POLL_INTERVAL_MS=5000
ARC_LOG_CHUNK_SIZE=10000
ARC_LOOKBACK_BLOCKS=2000000
ARC_MAX_CHUNKS_PER_RUN=50
ARC_POLL_INTERVAL_MS=3000
INDEXER_TAIL_WINDOW_BLOCKS=20000
INDEXER_REORG_REWIND=128
OUT_OF_RANGE_CONFIRM_BLOCKS=2
IN_RANGE_CONFIRM_BLOCKS=3
NOTIFY_BACK_IN_RANGE=false
ALERT_RULES_VERSION=1
EOF
else
  echo "keeping existing /etc/peachlpbot/env"
fi
chown root:peach /etc/peachlpbot/env
chmod 0640 /etc/peachlpbot/env

echo "bootstrap complete (user peach, database peachlpbot)"
