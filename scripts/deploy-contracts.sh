#!/usr/bin/env bash
#
# Deploy and initialize the x402 Soroban contracts to a Stellar network,
# then persist the new contract IDs to contracts/deployed-addresses.json.
#
# Fixes the historical gap where `stellar contract deploy` created wasm
# instances but never called `init()` (leaving the contracts unusable) and
# never persisted the new addresses (so the gateway kept pointing at stale,
# hardcoded IDs in packages/config).
#
# For each contract this script:
#   1. Builds the wasm (stellar contract build)
#   2. Deploys it (stellar contract deploy) and captures the contract ID
#   3. Calls `init` with the correct arguments for that contract
#   4. Merges the new IDs into contracts/deployed-addresses.json per network
#
# Usage:
#   STELLAR_SECRET_KEY=S... bash scripts/deploy-contracts.sh
#
# Required environment variables:
#   STELLAR_SECRET_KEY     Secret key (S...) of the deploying account. Its
#                          public key becomes the admin of payment-verifier
#                          and credit-escrow, and the default multisig signer.
#
# Optional environment variables:
#   STELLAR_NETWORK        Network name (default: testnet)
#   STELLAR_RPC_URL        Soroban RPC endpoint (default: per-network default)
#   STELLAR_NETWORK_PASSPHRASE  Network passphrase (default: per-network)
#   USDC_ISSUER            USDC issuer used to derive the asset contract
#                          (default: testnet USDC issuer)
#   MULTISIG_SIGNERS       Comma-separated public keys for the multisig
#                          (default: the admin's public key)
#   MULTISIG_THRESHOLD     Multisig approval threshold (default: 1)
#   OUTPUT_FILE            Where addresses are persisted
#                          (default: <repo>/contracts/deployed-addresses.json)
#
# Requires the `stellar` CLI (v20+) and `jq` on PATH.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Configuration ─────────────────────────────

STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
STELLAR_SECRET_KEY="${STELLAR_SECRET_KEY:-}"
USDC_ISSUER="${USDC_ISSUER:-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5}"
OUTPUT_FILE="${OUTPUT_FILE:-${ROOT_DIR}/contracts/deployed-addresses.json}"
MULTISIG_THRESHOLD="${MULTISIG_THRESHOLD:-1}"

# Well-known per-network defaults (mirror packages/config).
case "$STELLAR_NETWORK" in
  testnet)
    DEFAULT_RPC="https://soroban-testnet.stellar.org"
    DEFAULT_PASSPHRASE="Test SDF Network ; September 2015"
    ;;
  mainnet)
    DEFAULT_RPC="https://soroban-mainnet.stellar.org"
    DEFAULT_PASSPHRASE="Public Global Stellar Network ; September 2015"
    ;;
  futurenet)
    DEFAULT_RPC="https://rpc-futurenet.stellar.org"
    DEFAULT_PASSPHRASE="Test SDF Future Network ; October 2022"
    ;;
  *)
    echo "❌ Unsupported STELLAR_NETWORK='${STELLAR_NETWORK}'. Use testnet|mainnet|futurenet." >&2
    exit 1
    ;;
esac
STELLAR_RPC_URL="${STELLAR_RPC_URL:-$DEFAULT_RPC}"
STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-$DEFAULT_PASSPHRASE}"

# ── Prerequisite checks ───────────────────────

if [ -z "$STELLAR_SECRET_KEY" ]; then
  echo "⚠️  STELLAR_SECRET_KEY is not set — skipping contract deployment."
  echo "    (Set it to the secret key of a funded account to deploy.)"
  exit 0
fi

if ! command -v stellar >/dev/null 2>&1; then
  echo "❌ 'stellar' CLI not found on PATH. Install it first (see DEPLOYMENT.md)." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ 'jq' not found on PATH (required to persist addresses)." >&2
  exit 1
fi

# ── Ensure the network is configured (idempotent) ──

if ! stellar network ls 2>/dev/null | grep -qx "$STELLAR_NETWORK"; then
  echo "── Adding stellar network '${STELLAR_NETWORK}' ──"
  stellar network add "$STELLAR_NETWORK" \
    --rpc-url "$STELLAR_RPC_URL" \
    --network-passphrase "$STELLAR_NETWORK_PASSPHRASE"
else
  echo "── Stellar network '${STELLAR_NETWORK}' already configured ──"
fi

# ── Derive admin address + USDC asset contract ID ──

ADMIN_ADDRESS="$(stellar keys address "$STELLAR_SECRET_KEY")"
echo "Admin address (from STELLAR_SECRET_KEY): $ADMIN_ADDRESS"

USDC_SAC_ID="$(stellar contract id asset --asset "USDC:${USDC_ISSUER}" --network "$STELLAR_NETWORK")"
echo "USDC asset contract (SAC): $USDC_SAC_ID"

# Multisig signers: default to the admin when not provided. Tolerates
# "GAAA, GBBB" (spaces after commas) as well as "GAAA,GBBB".
if [ -z "${MULTISIG_SIGNERS:-}" ]; then
  MULTISIG_SIGNERS="$ADMIN_ADDRESS"
fi
SIGNERS_JSON="$(printf '%s\n' "$MULTISIG_SIGNERS" | sed 's/, */,/g' | sed 's/,/\n/g' | jq -R . | jq -s -c .)"

# ── Helpers ───────────────────────────────────

# Deploy a wasm file and echo the resulting contract ID.
#
# IMPORTANT: progress/log lines go to STDERR so that only the contract ID
# lands on stdout — the caller captures stdout via $(...) and must receive
# exactly one clean ID.
deploy_contract() {
  local name="$1"
  local wasm="$2"
  echo "── Deploying ${name} ──" >&2
  local out_file err_file id
  out_file="$(mktemp)"
  err_file="$(mktemp)"

  # Capture stdout and stderr separately: the contract ID is printed to
  # stdout, while logs (which may mention other C… addresses) go to stderr.
  if ! stellar contract deploy \
    --wasm "$wasm" \
    --source-account "$STELLAR_SECRET_KEY" \
    --network "$STELLAR_NETWORK" >"$out_file" 2>"$err_file"; then
    echo "❌ 'stellar contract deploy' failed for ${name}. Output:" >&2
    cat "$err_file" >&2
    cat "$out_file" >&2
    rm -f "$out_file" "$err_file"
    exit 1
  fi

  id="$(grep -oE 'C[A-Z2-7]{55}' "$out_file" | tail -n 1 || true)"
  rm -f "$out_file" "$err_file"

  if ! [[ "$id" =~ ^C[A-Z2-7]{55}$ ]]; then
    echo "❌ Could not extract a contract ID from the deploy output for ${name}." >&2
    exit 1
  fi
  echo "✅ ${name} deployed at ${id}" >&2
  echo "$id"
}

# Invoke `init` on a deployed contract (pass remaining args after `--`).
invoke_init() {
  local name="$1"
  local id="$2"
  shift 2
  echo "── Initializing ${name} (${id}) ──"
  stellar contract invoke \
    --id "$id" \
    --source-account "$STELLAR_SECRET_KEY" \
    --network "$STELLAR_NETWORK" \
    -- init "$@"
  echo "✅ ${name} initialized"
}

# ── Build, deploy, and initialize each contract ──

CONTRACTS_DIR="${CONTRACTS_DIR:-${ROOT_DIR}/contracts}"

PAYMENT_VERIFIER_ID=""
CREDIT_ESCROW_ID=""
MULTISIG_ID=""

for contract in payment-verifier credit-escrow multisig; do
  echo ""
  echo "════════ ${contract} ════════"
  (cd "${CONTRACTS_DIR}/${contract}" && stellar contract build)
  wasm="${CONTRACTS_DIR}/${contract}/target/wasm32-unknown-unknown/release/${contract//-/_}.wasm"
  deployed_id="$(deploy_contract "$contract" "$wasm")"
  case "$contract" in
    payment-verifier) PAYMENT_VERIFIER_ID="$deployed_id" ;;
    credit-escrow) CREDIT_ESCROW_ID="$deployed_id" ;;
    multisig) MULTISIG_ID="$deployed_id" ;;
  esac
done

echo ""
echo "════════ Initializing contracts ════════"

invoke_init "payment-verifier" "$PAYMENT_VERIFIER_ID" \
  --admin "$ADMIN_ADDRESS"

invoke_init "credit-escrow" "$CREDIT_ESCROW_ID" \
  --admin "$ADMIN_ADDRESS" \
  --asset "$USDC_SAC_ID"

invoke_init "multisig" "$MULTISIG_ID" \
  --threshold "$MULTISIG_THRESHOLD" \
  --signers "$SIGNERS_JSON" \
  --token "$USDC_SAC_ID"

# ── Persist addresses to contracts/deployed-addresses.json ──

echo ""
echo "════════ Persisting addresses ════════"

mkdir -p "$(dirname "$OUTPUT_FILE")"
if [ ! -f "$OUTPUT_FILE" ]; then
  printf '{}\n' > "$OUTPUT_FILE"
fi

TMP_FILE="$(mktemp)"
jq --arg net "$STELLAR_NETWORK" \
   --arg pv "$PAYMENT_VERIFIER_ID" \
   --arg ce "$CREDIT_ESCROW_ID" \
   --arg ms "$MULTISIG_ID" \
   --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
   '.[$net] = { paymentVerifier: $pv, creditEscrow: $ce, multisig: $ms, updatedAt: $ts }' \
   "$OUTPUT_FILE" > "$TMP_FILE"
mv "$TMP_FILE" "$OUTPUT_FILE"

echo "✅ Addresses written to ${OUTPUT_FILE}:"
jq . "$OUTPUT_FILE"
echo ""
echo "🎉 All contracts deployed and initialized on '${STELLAR_NETWORK}'."
