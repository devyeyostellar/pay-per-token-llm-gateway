#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-restore-drill.sh — automated Postgres backup/restore drill
#
# Proves the documented recovery path (OPERATIONS.md §2.1) end-to-end, every
# run, without touching real infrastructure:
#
#   1. Applies the REAL Prisma migration history to a throwaway source DB
#      (the same `prisma migrate deploy` a production deploy runs) — this
#      also catches schema/migration drift, not just backup correctness.
#   2. Seeds representative rows across every table (payments, debts, audit,
#      notifications, analytics, routes, providers, …).
#   3. `pg_dump --format=custom` → `pg_restore` into a FRESH database.
#   4. Asserts full parity: identical table list, identical row count per
#      table, and spot-checks sample rows (tx hash, debt amount, audit row).
#
# An untested backup is not a backup — this script is the "monthly restore
# drill" made automatic and CI-enforced.
#
# Usage:
#   scripts/backup-restore-drill.sh            # spins up two throwaway
#                                              # Postgres containers (docker)
#   DRILL_SOURCE_URL=... DRILL_TARGET_URL=... \
#     scripts/backup-restore-drill.sh          # use provided databases
#                                              # (CI: one service, two DBs)
#
# Exits non-zero on ANY mismatch.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$ROOT/packages/database/prisma/schema.prisma"
DUMP_FILE="${DRILL_DUMP_FILE:-$(mktemp /tmp/x402-drill-XXXXXX.dump)}"

PASS=0
FAIL=0

ok()  { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

# ── Database setup ──────────────────────────────────────────────────────────

SOURCE_URL="${DRILL_SOURCE_URL:-}"
TARGET_URL="${DRILL_TARGET_URL:-}"
SOURCE_CONTAINER=""
TARGET_CONTAINER=""

if [[ -z "$SOURCE_URL" || -z "$TARGET_URL" ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo "ERROR: docker is required (or set DRILL_SOURCE_URL + DRILL_TARGET_URL)" >&2
    exit 2
  }

  SOURCE_CONTAINER="x402-drill-source"
  TARGET_CONTAINER="x402-drill-target"

  cleanup() {
    docker rm -f "$SOURCE_CONTAINER" "$TARGET_CONTAINER" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  echo "── Starting throwaway Postgres containers ──"
  for name in "$SOURCE_CONTAINER" "$TARGET_CONTAINER"; do
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" \
      -e POSTGRES_USER=x402 -e POSTGRES_PASSWORD=x402_drill -e POSTGRES_DB=x402 \
      -p 127.0.0.1::5432 \
      postgres:16-alpine >/dev/null
  done

  wait_for_pg() {
    local container="$1"
    for _ in $(seq 1 60); do
      if docker exec "$container" pg_isready -U x402 >/dev/null 2>&1; then
        return 0
      fi
      sleep 1
    done
    echo "ERROR: Postgres did not become ready in $container" >&2
    exit 1
  }
  wait_for_pg "$SOURCE_CONTAINER"
  wait_for_pg "$TARGET_CONTAINER"

  source_port="$(docker port "$SOURCE_CONTAINER" 5432/tcp | cut -d: -f2)"
  target_port="$(docker port "$TARGET_CONTAINER" 5432/tcp | cut -d: -f2)"
  # Host-facing URL: the random host port. Container-facing URL: psql/
  # pg_dump/pg_restore run INSIDE the container, where Postgres is on 5432.
  SOURCE_URL="postgresql://x402:x402_drill@127.0.0.1:${source_port}/x402"
  TARGET_URL="postgresql://x402:x402_drill@127.0.0.1:${target_port}/x402"
  SOURCE_INSIDE_URL="postgresql://x402:x402_drill@127.0.0.1:5432/x402"
  TARGET_INSIDE_URL="postgresql://x402:x402_drill@127.0.0.1:5432/x402"
else
  # Provided-URL mode (CI): psql/pg_dump run in throwaway containers with
  # --network host, so the host-facing URL is also the inside URL.
  SOURCE_INSIDE_URL="$SOURCE_URL"
  TARGET_INSIDE_URL="$TARGET_URL"
fi

echo "── Step 1: apply real migration history to SOURCE ──"
(
  # prisma is a devDependency of the database package — run from its cwd,
  # exactly like the `database:migrate` Nx target does.
  cd "$ROOT/packages/database"
  DATABASE_URL="$SOURCE_URL" npx prisma migrate deploy
)
echo "── Step 2: seed representative data ──"
seed_sql=$(cat <<'SQL'
INSERT INTO "Provider" (id, name, "walletAddress", "payoutWalletAddress", "webhookUrl", "webhookSecret", active, "createdAt", "updatedAt") VALUES
  ('prov-1', 'Drill Provider', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', 'https://example.com/hook', 'drill-secret', true, NOW(), NOW());
INSERT INTO "Route" (id, "providerId", path, "upstreamUrl", model, "pricingModel", "flatPrice", "perTokenPrice", "acceptedAssets", "rateLimit", active, "createdAt", "updatedAt") VALUES
  ('route-1', 'prov-1', '/v1/chat/completions', 'https://api.openai.com/v1/chat/completions', 'gpt-4', 'flat', '1000000', NULL, ARRAY['USDC'], 10, true, NOW(), NOW());
INSERT INTO "Payment" (id, "quoteId", "routeId", "providerId", "txHash", "payerAddress", amount, asset, status, ledger, "verifiedAt", "receiptJson", "createdAt", "updatedAt") VALUES
  ('pay-1', 'quote-1', 'route-1', 'prov-1', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 1000000, 'USDC', 'confirmed', 123456, NOW(), '{"quoteId":"quote-1"}'::jsonb, NOW(), NOW()),
  ('pay-2', 'quote-2', 'route-1', 'prov-1', NULL, NULL, 2000000, 'USDC', 'pending', NULL, NULL, NULL, NOW(), NOW());
INSERT INTO "Wallet" (id, address, label, "isProvider", "createdAt", "updatedAt") VALUES
  ('wallet-1', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'drill', false, NOW(), NOW());
INSERT INTO "PrepaidCredit" (id, "walletId", "providerId", balance, asset, "createdAt", "updatedAt") VALUES
  ('credit-1', 'wallet-1', 'prov-1', 5000000, 'USDC', NOW(), NOW());
INSERT INTO "UnderpaymentDebt" (id, "providerId", "payerAddress", "quoteId", "routeId", amount, status, "createdAt") VALUES
  ('debt-1', 'prov-1', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'quote-debt-1', 'route-1', 4200, 'open', NOW());
INSERT INTO "Notification" (id, "providerId", event, channel, payload, sent, "createdAt") VALUES
  ('notif-1', 'prov-1', 'payment_received', 'in_app', '{"txHash":"a1b2c3"}'::jsonb, true, NOW());
INSERT INTO "AnalyticsEvent" (id, type, route, "providerId", "callerAddress", amount, asset, "responseTime", "createdAt") VALUES
  ('analytics-1', 'request:paid', '/v1/chat/completions', 'prov-1', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 1000000, 'USDC', 1200, NOW());
INSERT INTO "AuditLog" (id, action, entity, "entityId", "providerId", actor, details, ip, "createdAt") VALUES
  ('audit-1', 'payment_verified', 'payment', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3', 'prov-1', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', '{"route":"/v1/chat/completions"}'::jsonb, '127.0.0.1', NOW());
SQL
)
if [[ -n "$SOURCE_CONTAINER" ]]; then
  docker exec -i "$SOURCE_CONTAINER" psql "$SOURCE_INSIDE_URL" -v ON_ERROR_STOP=1 -q <<< "$seed_sql"
else
  # No local psql guaranteed — run the SQL through a throwaway container.
  docker run --rm -i --network host postgres:16-alpine psql "$SOURCE_INSIDE_URL" -v ON_ERROR_STOP=1 -q <<< "$seed_sql"
fi

echo "── Step 3: pg_dump SOURCE → pg_restore TARGET ──"
if [[ -n "$SOURCE_CONTAINER" ]]; then
  docker exec "$SOURCE_CONTAINER" pg_dump "$SOURCE_INSIDE_URL" --format=custom --no-owner > "$DUMP_FILE"
  docker exec -i "$TARGET_CONTAINER" pg_restore -d "$TARGET_INSIDE_URL" --clean --if-exists --no-owner < "$DUMP_FILE"
else
  docker run --rm --network host postgres:16-alpine pg_dump "$SOURCE_INSIDE_URL" --format=custom --no-owner > "$DUMP_FILE"
  docker run --rm -i --network host postgres:16-alpine pg_restore -d "$TARGET_INSIDE_URL" --clean --if-exists --no-owner < "$DUMP_FILE"
fi

echo "── Step 4: parity assertions ──"
query() { # query <container|''> <inside-url> <sql>
  local container="$1" url="$2" sql="$3"
  if [[ -n "$container" ]]; then
    docker exec "$container" psql "$url" -tA -c "$sql"
  else
    docker run --rm --network host postgres:16-alpine psql "$url" -tA -c "$sql"
  fi
}

tables() { # tables <container|''> <inside-url>
  query "$1" "$2" "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;"
}

src_tables="$(tables "$SOURCE_CONTAINER" "$SOURCE_INSIDE_URL")"
tgt_tables="$(tables "$TARGET_CONTAINER" "$TARGET_INSIDE_URL")"
if [[ "$src_tables" == "$tgt_tables" ]]; then
  ok "identical table list ($(echo "$src_tables" | grep -c .) tables)"
else
  bad "table list mismatch"
  diff <(echo "$src_tables") <(echo "$tgt_tables") || true
fi

for table in $src_tables; do
  src_count="$(query "$SOURCE_CONTAINER" "$SOURCE_INSIDE_URL" "SELECT count(*) FROM \"$table\";")"
  tgt_count="$(query "$TARGET_CONTAINER" "$TARGET_INSIDE_URL" "SELECT count(*) FROM \"$table\";")"
  if [[ "$src_count" == "$tgt_count" ]]; then
    ok "$table row count: $src_count"
  else
    bad "$table row count: source=$src_count target=$tgt_count"
  fi
done

# Spot-check sample rows (semantic parity, not just counts).
spot() { # spot <label> <sql> — compares single-column query output on both DBs
  local label="$1" sql="$2"
  local s t
  s="$(query "$SOURCE_CONTAINER" "$SOURCE_INSIDE_URL" "$sql")"
  t="$(query "$TARGET_CONTAINER" "$TARGET_INSIDE_URL" "$sql")"
  if [[ "$s" == "$t" ]]; then
    ok "spot-check $label: $s"
  else
    bad "spot-check $label: source=$s target=$t"
  fi
}
spot "confirmed payment txHash+amount" \
  "SELECT \"txHash\" || '|' || amount FROM \"Payment\" WHERE status='confirmed';"
spot "underpayment debt amount" \
  "SELECT amount || '|' || status FROM \"UnderpaymentDebt\" WHERE \"quoteId\"='quote-debt-1';"
spot "audit action" \
  "SELECT action || '|' || \"providerId\" FROM \"AuditLog\" WHERE id='audit-1';"
spot "pending payment intact" \
  "SELECT status || '|' || COALESCE(\"txHash\", 'NULL') FROM \"Payment\" WHERE id='pay-2';"

echo ""
echo "══ RESULT: $PASS passed, $FAIL failed ══"
echo "  dump file: $DUMP_FILE"
if [[ "$FAIL" -gt 0 ]]; then
  echo "  ❌ Drill FAILED — backup/restore parity is broken." >&2
  exit 1
fi
echo "  ✅ Drill PASSED — dump/restore round-trip is lossless."