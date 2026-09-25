#!/usr/bin/env bash
# Points CardVault's token metadata and site links at the production domain.
# Sends one transaction from the deployer (the vault owner). Reads secrets from the git-ignored .env.
#
# Usage: ./scripts/set-uris.sh [base-uri] [site-uri]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL is not set in .env}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is not set in .env}"

BASE="${1:-https://kuravault.xyz/api/meta/}"
SITE="${2:-https://kuravault.xyz/app/cards/}"
VAULT="$(node -e "console.log(require('$ROOT/contracts/deployments/sepolia.json').cardVault)")"

echo "CardVault $VAULT"
echo "  baseURI -> $BASE"
echo "  siteURI -> $SITE"
cast send "$VAULT" "setURIs(string,string)" "$BASE" "$SITE" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL"

echo
echo "tokenURI(1) is now: $(cast call "$VAULT" "tokenURI(uint256)(string)" 1 --rpc-url "$SEPOLIA_RPC_URL")"
