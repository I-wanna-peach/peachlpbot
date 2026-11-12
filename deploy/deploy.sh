#!/usr/bin/env bash
# Deploy a release to the Seoul host and restart the service.
#
#   RELEASE=20261022-r1 bash deploy/deploy.sh
#
# Run from anywhere inside the repo. Secrets stay in /etc/peachlpbot/env.
set -euo pipefail

cd "$(dirname "$0")/.."
HOST="${HOST:-seoul}"
RELEASE="${RELEASE:-$(date +%Y%m%d-%H%M%S)}"
REMOTE="/opt/peachlpbot/releases/${RELEASE}"

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude '.env.*' --exclude .git \
  --exclude .commandcode --exclude test --exclude dist --exclude '*.log' \
  ./ "${HOST}:${REMOTE}/"

ssh "$HOST" bash -s <<EOF
set -euo pipefail
cd "${REMOTE}"
/usr/local/bin/bun install --production --frozen-lockfile
# /usr/local/bin/bun is a symlink into a home directory, which ProtectHome
# hides. Keep a real copy for the unit to execute.
install -d -m 0755 /opt/peachlpbot/bin
install -m 0755 "$(readlink -f /usr/local/bin/bun)" /opt/peachlpbot/bin/bun
chown -R root:peach .
chmod -R g+rX .
install -m 0644 deploy/systemd/peachlpbot.service /etc/systemd/system/peachlpbot.service
ln -sfn "${REMOTE}" /opt/peachlpbot/current
systemctl daemon-reload
set -a
. /etc/peachlpbot/env
set +a
/usr/local/bin/bun run migrate
systemctl enable peachlpbot.service
systemctl restart peachlpbot.service
systemctl --no-pager --lines=20 status peachlpbot.service
EOF
