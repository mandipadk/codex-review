#!/usr/bin/env bash
set -euo pipefail

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler not found. Install with: pnpm --filter @pr-guardian/cloudflare-worker exec wrangler --version"
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <cloudflare-worker-name>"
  echo "Example: $0 pr-guardian-arena"
  exit 1
fi

WORKER_NAME="$1"
DB_NAME="${WORKER_NAME}"
QUEUE_NAME="${WORKER_NAME}-runs"

cd "$(dirname "$0")/../services/cloudflare-worker"

echo "[1/5] Checking Wrangler auth"
wrangler whoami >/dev/null

echo "[2/5] Creating D1 database: ${DB_NAME}"
wrangler d1 create "${DB_NAME}"

echo "[3/5] Creating Queue: ${QUEUE_NAME}"
wrangler queues create "${QUEUE_NAME}"

echo "[4/5] Update wrangler.toml manually with the D1 database_id and queue name"
echo "       - d1_databases[0].database_name = ${DB_NAME}"
echo "       - queues.producers[0].queue = ${QUEUE_NAME}"
echo "       - queues.consumers[0].queue = ${QUEUE_NAME}"

echo "[5/5] Apply migrations"
wrangler d1 migrations apply "${DB_NAME}" --remote

echo "Bootstrap complete. Next: set secrets and run 'pnpm deploy:cf' from repo root."
