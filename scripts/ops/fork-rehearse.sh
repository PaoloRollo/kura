#!/usr/bin/env bash
# Rehearses a deployment before it goes to Sepolia. Starts a local anvil fork of Sepolia, runs Deploy.s.sol against it
# (addresses go to contracts/deployments/tmp/, which git ignores), then runs `pnpm rehearse --dry-run` on a fork of that
# anvil. Nothing is sent to Sepolia: every broadcast goes to 127.0.0.1.
#
# Usage: pnpm rehearse:fork        (FORK_PORT=8547 by default; the rehearsal's own anvil uses 8546)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL is not set in .env}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is not set in .env}"

export VENDOR_FEE_BPS="${VENDOR_FEE_BPS:-250}"
export BASE_URI="${BASE_URI:-https://kura.example/api/meta/}"
export SITE_URI="${SITE_URI:-https://kura.example/app/cards/}"
export VENDOR_PAYOUT_ADDRESS="${VENDOR_PAYOUT_ADDRESS:-${VENDOR_ADDRESS:-}}"

PORT="${FORK_PORT:-8547}"
LOCAL="http://127.0.0.1:$PORT"
TMP="$ROOT/contracts/deployments/tmp"
mkdir -p "$TMP"
cp "$ROOT/contracts/deployments/sepolia.ens.json" "$TMP/sepolia.ens.json"
rm -f "$TMP/sepolia.json"

echo "==> anvil (nice) on :$PORT, forking Sepolia"
nice -n 10 anvil --fork-url "$SEPOLIA_RPC_URL" --port "$PORT" --silent &
ANVIL=$!
trap 'kill "$ANVIL" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break
  sleep 0.25
done
[[ "$(cast chain-id --rpc-url "$LOCAL")" == "11155111" ]] || { echo "anvil on $LOCAL is not a Sepolia fork" >&2; exit 1; }

cd "$ROOT/contracts"
echo "==> building"
nice forge build
echo "==> Deploy.s.sol on the fork ($LOCAL)"
# Broadcast records go to broadcast-fork/, so the real deploy's broadcast/ (used by --resume --verify) is untouched.
KURA_DEPLOYMENTS_DIR=deployments/tmp FOUNDRY_BROADCAST=broadcast-fork \
  nice forge script script/Deploy.s.sol:Deploy --rpc-url "$LOCAL" --broadcast
[[ -f "$TMP/sepolia.json" ]] || { echo "Deploy.s.sol did not write $TMP/sepolia.json" >&2; exit 1; }

cd "$ROOT"
echo "==> rehearsal (dry run) against the fork deployment"
nice pnpm rehearse --dry-run --fork-url "$LOCAL" --deployments contracts/deployments/tmp/sepolia.json "$@"
