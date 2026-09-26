// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Converts a CCA clearing price into the starting price of the card's Uniswap v4 pool.
library MarketMath {
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant Q192 = 2 ** 192;

    /// @notice The v4 `sqrtPriceX96` for a pool of shards vs USDC opening at `clearingPriceQ96`.
    /// @param clearingPriceQ96 USDC raw units per shard raw unit, scaled by 2**96 (the CCA's price format).
    /// @param shardIsCurrency0 Whether the shard token sorts below USDC. v4 prices are currency1 per currency0.
    /// @return The square root of the pool price in Q64.96, clamped into the range v4 accepts.
    function sqrtPriceX96(uint256 clearingPriceQ96, bool shardIsCurrency0) internal pure returns (uint160) {
        uint256 s;
        if (shardIsCurrency0) {
            // price = usdc/shard = c / 2^96, so sqrtPriceX96 = sqrt(c / 2^96) * 2^96 = sqrt(c * 2^96)
            s = clearingPriceQ96 > type(uint160).max ? type(uint256).max : Math.sqrt(clearingPriceQ96 << 96);
        } else {
            // price = shard/usdc = 2^96 / c, so sqrtPriceX96 = sqrt(2^96 / c * 2^192) = sqrt(2^288 / c)
            s = clearingPriceQ96 <= 2 ** 32 ? type(uint256).max : Math.sqrt(Math.mulDiv(Q192, Q96, clearingPriceQ96));
        }
        if (s <= TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE + 1;
        if (s >= TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }
}
