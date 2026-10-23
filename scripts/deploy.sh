#!/usr/bin/env bash
# Build on this machine and install on a server that has Node but no npm or git checkout.
# Usage: npm run deploy -- <ssh-host>
# Asks for your sudo password on the server once. Override paths with INSTALL_DIR and PORT.
set -euo pipefail

host="${1:?Usage: npm run deploy -- <ssh-host>   (e.g. npm run deploy -- hoeserver)}"
install_dir="${INSTALL_DIR:-/opt/mess-mcp}"
port="${PORT:-3000}"
bundle="$(mktemp -d)/mess-mcp"
trap 'rm -rf "$(dirname "$bundle")"' EXIT

echo "==> Building and testing"
npm test --silent

echo "==> Bundling dist/ with production dependencies"
mkdir -p "$bundle"
cp -r dist package.json package-lock.json "$bundle/"
(cd "$bundle" && npm ci --omit=dev --ignore-scripts --silent)

echo "==> Copying to $host:~/staging/mess-mcp"
rsync -a --delete "$bundle/" "$host:staging/mess-mcp/"

echo "==> Installing to $install_dir and restarting (sudo may ask for your password)"
ssh -t "$host" "sudo rsync -a --delete --chown=root:root ~/staging/mess-mcp/ '$install_dir/' \
  && sudo systemctl restart mess-mcp \
  && sleep 2 \
  && systemctl is-active --quiet mess-mcp \
  && curl -fsS http://127.0.0.1:$port/healthz >/dev/null \
  && sudo journalctl -u mess-mcp -n 3 --no-pager -o cat"

echo "==> Deployed $(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo ' (plus uncommitted changes)') to $host"
