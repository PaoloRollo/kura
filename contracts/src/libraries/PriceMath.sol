// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Conversions between USDC-per-whole-shard prices and the CCA's Q96 currency-per-token-unit prices.
/// Shards have 18 decimals, USDC has 6. Q96 prices are currency units per token unit, scaled by 2**96.
library PriceMath {
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant SHARD = 1e18;

    /// @notice Converts a USDC-per-whole-shard price into the CCA's Q96 currency-per-token-unit price.
    /// @dev Rounds up so that a round trip through q96ToUsdcPerShard returns the input exactly.
    /// @param usdcPerShard USDC (6 decimals) owed per whole shard (1e18 shard units).
    /// @return priceQ96 The price expressed as currency units per token unit, scaled by 2**96.
    function usdcPerShardToQ96(uint256 usdcPerShard) internal pure returns (uint256 priceQ96) {
        return Math.mulDiv(usdcPerShard, Q96, SHARD, Math.Rounding.Ceil);
    }

    /// @notice Converts a Q96 currency-per-token-unit price back into USDC-per-whole-shard.
    /// @dev Rounds down.
    /// @param priceQ96 The price expressed as currency units per token unit, scaled by 2**96.
    /// @return usdcPerShard USDC (6 decimals) owed per whole shard (1e18 shard units).
    function q96ToUsdcPerShard(uint256 priceQ96) internal pure returns (uint256 usdcPerShard) {
        return Math.mulDiv(priceQ96, SHARD, Q96);
    }

    /// @notice Computes the USDC owed for a quantity of shard units at a given price.
    /// @dev Rounds down.
    /// @param usdcPerShard USDC (6 decimals) owed per whole shard (1e18 shard units).
    /// @param shardUnits Quantity of shard units (18 decimals).
    /// @return usdc USDC (6 decimals) owed for `shardUnits` at `usdcPerShard`.
    function payoutFor(uint256 usdcPerShard, uint256 shardUnits) internal pure returns (uint256 usdc) {
        return Math.mulDiv(usdcPerShard, shardUnits, SHARD);
    }
}
