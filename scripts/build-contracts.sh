#!/usr/bin/env bash
#
# Build all Soroban contracts to optimized release wasm.
#
# Preferred tool: the Stellar CLI (`stellar contract build`) — this matches the
# flow documented in README.md / DEPLOYMENT.md and the tag-triggered deploy
# workflow (.github/workflows/deploy.yml).
#
# Fallback: plain `cargo build --release --target wasm32-unknown-unknown` for
# contributors who only have Rust installed (the wasm32 target is added
# automatically when rustup is available).
#
# Usage: pnpm build:contracts   (or)   bash scripts/build-contracts.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS=(payment-verifier credit-escrow multisig)

if command -v stellar >/dev/null 2>&1; then
  BUILD_CMD=(stellar contract build)
  echo "Using stellar CLI: ${BUILD_CMD[*]}"
else
  echo "stellar CLI not found — falling back to cargo..."
  if command -v rustup >/dev/null 2>&1; then
    if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
      echo "Adding wasm32-unknown-unknown target via rustup..."
      rustup target add wasm32-unknown-unknown
    fi
  else
    echo "⚠ rustup not found — assuming wasm32-unknown-unknown is already installed"
  fi
  BUILD_CMD=(cargo build --release --target wasm32-unknown-unknown)
fi

for contract in "${CONTRACTS[@]}"; do
  echo "── Building ${contract} ──"
  (cd "${ROOT_DIR}/contracts/${contract}" && "${BUILD_CMD[@]}")
done

echo "✅ All contracts built"
