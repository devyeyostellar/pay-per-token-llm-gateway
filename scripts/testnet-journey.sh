#!/usr/bin/env bash
#
# Live Stellar Testnet journey — reproducible end-to-end evidence.
#
# Boots the full stack locally (Postgres + Redis in Docker, the gateway on
# port 3100), then runs scripts/testnet-journey.ts against the LIVE Stellar
# Testnet:
#
#   fund → trustline → mint → 402 quote → on-chain payment → 200 + receipt
#        → replay rejected (single-use) → forged hash rejected (fail-closed)
#
# Evidence (full transaction hashes, ledger sequence, balances, Horizon
# links) is written to docs/evidence/testnet-journey.json and printed as a
# table. Any unexpected HTTP status fails the run.
#
# Requirements: docker (running), node, pnpm, network access to the Stellar
# Testnet (Horizon + friendbot + Soroban RPC).
#
# Usage: bash scripts/testnet-journey.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR=".testnet-journey"
mkdir -p "$STATE_DIR" docs/evidence

PG_PORT="${PG_PORT:-55432}"
REDIS_PORT="${REDIS_PORT:-56379}"
GATEWAY_PORT="${GATEWAY_PORT:-3100}"
PG_NAME="x402-journey-pg"
REDIS_NAME="x402-journey-redis"
PG_DB="x402"
PG_USER="x402"
PG_PASS="x402-journey-local"

GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

# ── 1. Postgres ─────────────────────────────────────────────
log "Starting Postgres (${PG_NAME}) on port ${PG_PORT}"
if docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  echo "  (reusing running container)"
elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  docker start "$PG_NAME" >/dev/null
  echo "  (restarted existing container)"
else
  docker run -d --name "$PG_NAME" \
    -e POSTGRES_DB="$PG_DB" -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASS" \
    -p "127.0.0.1:${PG_PORT}:5432" \
    postgres:16-alpine >/dev/null
fi
for i in $(seq 1 30); do
  docker exec "$PG_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 1
done
echo "  postgres ready"

# ── 2. Redis ────────────────────────────────────────────────
log "Starting Redis (${REDIS_NAME}) on port ${REDIS_PORT}"
if docker ps --format '{{.Names}}' | grep -qx "$REDIS_NAME"; then
  echo "  (reusing running container)"
elif docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_NAME"; then
  docker start "$REDIS_NAME" >/dev/null
  echo "  (restarted existing container)"
else
  docker run -d --name "$REDIS_NAME" -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null
fi
redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 || for i in $(seq 1 30); do
  redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break
  sleep 1
done
echo "  redis ready"

# ── 3. Migrations + Prisma client ───────────────────────────
log "Applying database migrations"
pnpm nx run database:generate >/dev/null 2>&1 || true
(cd packages/database && DATABASE_URL="$DATABASE_URL" pnpm exec prisma migrate deploy)
echo "  migrations applied"

# ── 4. Issuer secret (persisted so reruns reuse the funded issuer) ──
log "Preparing journey issuer"
ISSUER_STATE="$STATE_DIR/issuer.env"
if [ -f "$ISSUER_STATE" ]; then
  # shellcheck disable=SC1090
  . "$ISSUER_STATE"
  echo "  (reusing issuer from $ISSUER_STATE)"
else
  ISSUER_SECRET="$(cd packages/wallet && node -e "const {Keypair}=require('@stellar/stellar-sdk'); process.stdout.write(Keypair.random().secret())")"
  echo "ISSUER_SECRET=$ISSUER_SECRET" > "$ISSUER_STATE"
  echo "  (generated fresh issuer)"
fi
export ISSUER_SECRET

# ── 5. Build the gateway if needed ──────────────────────────
if [ ! -f dist/apps/gateway/main.js ]; then
  log "Building gateway (first run)"
  pnpm nx build gateway
fi

# ── 6. Start the gateway ────────────────────────────────────
log "Starting gateway on port ${GATEWAY_PORT}"
JWT_SECRET="$(openssl rand -hex 32)"
cat > "$STATE_DIR/gateway.env" <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=$GATEWAY_PORT
PUBLIC_GATEWAY_URL=$GATEWAY_URL
DATABASE_URL=$DATABASE_URL
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
JWT_SECRET=$JWT_SECRET
STELLAR_NETWORK=testnet
USDC_ISSUER=$(cd packages/wallet && ISSUER_SECRET="$ISSUER_SECRET" node -e "const {Keypair}=require('@stellar/stellar-sdk'); process.stdout.write(Keypair.fromSecret(process.env.ISSUER_SECRET).publicKey())")
WEBHOOK_ENABLED=false
EOF
# shellcheck disable=SC1091
set -a; . "$STATE_DIR/gateway.env"; set +a

if [ -f "$STATE_DIR/gateway.pid" ] && kill -0 "$(cat "$STATE_DIR/gateway.pid")" 2>/dev/null; then
  echo "  (gateway already running, pid $(cat "$STATE_DIR/gateway.pid"))"
else
  NODE_PATH=packages/database/node_modules:node_modules \
    nohup node dist/apps/gateway/main.js > "$STATE_DIR/gateway.log" 2>&1 &
  echo $! > "$STATE_DIR/gateway.pid"
  for i in $(seq 1 60); do
    if curl -sf "$GATEWAY_URL/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -sf "$GATEWAY_URL/health" >/dev/null || {
    echo "gateway failed to start — see $STATE_DIR/gateway.log" >&2
    tail -30 "$STATE_DIR/gateway.log" >&2
    exit 1
  }
  echo "  gateway healthy"
fi

# ── 7. Run the journey ──────────────────────────────────────
log "Running live testnet journey"
set +e
# Transpile-only: skips diagnostics so pnpm-isolated deps (@stellar/
# stellar-sdk lives under packages/wallet/node_modules) resolve at runtime
# via NODE_PATH instead of failing module resolution from scripts/.
GATEWAY_URL="$GATEWAY_URL" \
ISSUER_SECRET="$ISSUER_SECRET" \
DATABASE_URL="$DATABASE_URL" \
EVIDENCE_PATH="docs/evidence/testnet-journey.json" \
TS_NODE_TRANSPILE_ONLY=1 \
NODE_PATH="packages/wallet/node_modules:packages/database/node_modules:apps/gateway/node_modules:node_modules" \
  npx ts-node --project apps/gateway/tsconfig.json scripts/testnet-journey.ts
JOURNEY_EXIT=$?
set -e

echo
if [ $JOURNEY_EXIT -eq 0 ]; then
  echo -e "\033[1;32m═══════════════════════════════════════════════════════════════"
  echo "  LIVE TESTNET JOURNEY: ALL CHECKS PASSED"
  echo "  Evidence: docs/evidence/testnet-journey.json"
  echo "═══════════════════════════════════════════════════════════════\033[0m"
else
  echo -e "\033[1;31mLIVE TESTNET JOURNEY FAILED (exit $JOURNEY_EXIT)\033[0m" >&2
fi
exit $JOURNEY_EXIT