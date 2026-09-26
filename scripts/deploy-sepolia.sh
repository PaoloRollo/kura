#!/usr/bin/env bash
# Deploys Kura to Sepolia: registers the vault's .eth name (commit, wait, register),
# deploys the contracts and seeds one demo card. Reads secrets from the git-ignored .env.
#
# After Deploy it regenerates packages/shared/src/abi.ts and syncs the deployments to the web and the indexer.
# Rehearse a deployment on a local fork first: pnpm rehearse:fork (nothing reaches Sepolia).
#
# Usage: ./scripts/deploy-sepolia.sh            full run
#        ./scripts/deploy-sepolia.sh deploy     skip ENS setup (name already registered)
#        ./scripts/deploy-sepolia.sh seed       only the seed step
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL is not set in .env}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is not set in .env}"
: "${VENDOR_PRIVATE_KEY:?VENDOR_PRIVATE_KEY is not set in .env}"
: "${SIGNER_ADDRESS:?SIGNER_ADDRESS is not set in .env}"

export ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-}"
export VENDOR_FEE_BPS="${VENDOR_FEE_BPS:-250}"
export VAULT_ENS_LABEL="${VAULT_ENS_LABEL:-kura}"
export BASE_URI="${BASE_URI:-https://kura.example/api/meta/}"
export SITE_URI="${SITE_URI:-https://kura.example/app/cards/}"
export DEMO_OWNER="${DEMO_OWNER:-$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")}"

RPC="$SEPOLIA_RPC_URL"
STEP="${1:-all}"

# Contract libraries are git submodules. Fetch only the top level: the CCA's own nested
# submodules are not needed to build and would pull over a gigabyte.
if [[ ! -f "$ROOT/contracts/lib/forge-std/src/Script.sol" \
   || ! -f "$ROOT/contracts/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol" \
   || ! -f "$ROOT/contracts/lib/continuous-clearing-auction/src/interfaces/IValidationHook.sol" \
   || ! -f "$ROOT/contracts/lib/v4-periphery/lib/v4-core/lib/solmate/src/tokens/ERC721.sol" \
   || ! -f "$ROOT/contracts/lib/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol" ]]; then
  echo "==> fetching contract libraries"
  git -C "$ROOT" submodule update --init \
    contracts/lib/forge-std contracts/lib/openzeppelin-contracts contracts/lib/continuous-clearing-auction \
    contracts/lib/v4-periphery
  # Uniswap v4: only the nested libraries the imports need (v4-core, permit2, and v4-core's solmate).
  git -C "$ROOT/contracts/lib/v4-periphery" submodule update --init lib/v4-core lib/permit2
  git -C "$ROOT/contracts/lib/v4-periphery/lib/v4-core" submodule update --init lib/solmate
fi

cd "$ROOT/contracts"
echo "==> building"
forge build

run() {
  echo
  echo "==> $1"
  forge script "$1" --rpc-url "$RPC" --broadcast "${@:2}"
}

if [[ "$STEP" == "all" ]]; then
  run script/SetupEns.s.sol:SetupEnsCommit
  echo
  echo "==> waiting 75 s for the registrar's commitment age"
  sleep 75
  run script/SetupEns.s.sol:SetupEnsRegister
fi

if [[ "$STEP" == "all" || "$STEP" == "deploy" ]]; then
  run script/Deploy.s.sol:Deploy
  echo
  echo "==> verifying sources on Blockscout (failures here don't affect the deployment)"
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --resume --verify \
    --verifier blockscout --verifier-url https://eth-sepolia.blockscout.com/api/ \
    || echo "verification failed; the contracts are deployed, verify later" >&2
  echo
  echo "==> regenerating the shared ABIs and syncing deployments"
  node "$ROOT/scripts/gen-abi.mjs"
  node "$ROOT/scripts/sync-deployments.mjs"
fi

if [[ "$STEP" == "all" || "$STEP" == "deploy" || "$STEP" == "seed" ]]; then
  run script/Seed.s.sol:Seed
fi

echo
echo "Done. Deployment files:"
ls -1 "$ROOT/contracts/deployments/"

if [[ "$STEP" == "all" || "$STEP" == "deploy" ]]; then
  cat <<'NEXT'

Next steps:
  1. Commit the deployments and ABIs:
       git add contracts/deployments/sepolia.json packages/shared/src/abi.ts \
         apps/web/src/generated/deployments.json apps/indexer/generated/deployments.json
       git commit -m "chore(deploy): sepolia redeploy with the shard market"
  2. Review, then reset the database (drops the Ponder schemas, empties the chain-bound app tables):
       pnpm db:reset && pnpm db:reset --apply
  3. Redeploy the indexer on Railway and wait for /ready.
  4. Seed the demo: pnpm rehearse --dry-run, then pnpm rehearse --broadcast (needs a TTY)
NEXT
fi
