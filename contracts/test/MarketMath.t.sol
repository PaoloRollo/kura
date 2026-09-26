// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {MarketMath} from "../src/libraries/MarketMath.sol";

contract MarketMathTest is Test {
    uint256 constant Q96 = 2 ** 96;
    uint256 constant Q192 = 2 ** 192;
    uint256 constant ONE_TICK = 1e14; // 0.01 percent, in assertApproxEqRel units

    /// @dev Q96 USDC-units-per-shard-unit price for `usdcPerShard` (6 dp) per whole shard (18 dp).
    function _q96(uint256 usdcPerShard) internal pure returns (uint256) {
        return Math.mulDiv(usdcPerShard, Q96, 1e18);
    }

    /// @dev Inverse of MarketMath.sqrtPriceX96: the clearing price implied by a pool sqrt price.
    function _clearingFromSqrt(uint160 sqrtP, bool shardIsCurrency0) internal pure returns (uint256) {
        if (shardIsCurrency0) return Math.mulDiv(sqrtP, sqrtP, Q96); // usdc/shard * 2^96
        // pool price is shard/usdc = sqrt^2 / 2^192, clearing = 2^96 / price = 2^288 / sqrt^2
        return Math.mulDiv(Q192 / sqrtP, Q96, sqrtP);
    }

    /// @dev Round-trip through the tick grid: tick at the sqrt price, then back to a sqrt price at that tick.
    function _roundTrip(uint256 clearingQ96, bool shardIsCurrency0) internal pure returns (uint256) {
        uint160 sqrtP = MarketMath.sqrtPriceX96(clearingQ96, shardIsCurrency0);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        return _clearingFromSqrt(TickMath.getSqrtPriceAtTick(tick), shardIsCurrency0);
    }

    function test_tenDollarsShardIsCurrency0() public pure {
        uint256 c = _q96(10e6);
        assertApproxEqRel(_roundTrip(c, true), c, ONE_TICK);
        assertApproxEqRel(_clearingFromSqrt(MarketMath.sqrtPriceX96(c, true), true), c, 1e9, "exact before ticks");
    }

    function test_tenDollarsShardIsCurrency1() public pure {
        uint256 c = _q96(10e6);
        assertApproxEqRel(_roundTrip(c, false), c, ONE_TICK);
        assertApproxEqRel(_clearingFromSqrt(MarketMath.sqrtPriceX96(c, false), false), c, 1e9, "exact before ticks");
    }

    function test_ordersAreReciprocal() public pure {
        uint256 c = _q96(10e6);
        uint256 s0 = MarketMath.sqrtPriceX96(c, true);
        uint256 s1 = MarketMath.sqrtPriceX96(c, false);
        // sqrt(p) * sqrt(1/p) = 1, i.e. s0 * s1 = 2^192
        assertApproxEqRel(s0 * s1, Q192, 1e9);
    }

    function test_extremeLowPrice() public pure {
        uint256 c = _q96(1); // $0.000001 per shard
        assertApproxEqRel(_roundTrip(c, true), c, ONE_TICK);
        assertApproxEqRel(_roundTrip(c, false), c, ONE_TICK);
    }

    function test_extremeHighPrice() public pure {
        uint256 c = _q96(1_000_000e6); // $1,000,000 per shard
        assertApproxEqRel(_roundTrip(c, true), c, ONE_TICK);
        assertApproxEqRel(_roundTrip(c, false), c, ONE_TICK);
    }

    function test_zeroAndHugeAreClamped() public pure {
        uint160 lo = TickMath.MIN_SQRT_PRICE + 1;
        uint160 hi = TickMath.MAX_SQRT_PRICE - 1;
        assertEq(MarketMath.sqrtPriceX96(0, true), lo);
        assertEq(MarketMath.sqrtPriceX96(0, false), hi);
        assertEq(MarketMath.sqrtPriceX96(type(uint256).max, true), hi);
        assertEq(MarketMath.sqrtPriceX96(type(uint256).max, false), lo);
    }

    function testFuzz_withinBounds(uint256 c, bool shardIsCurrency0) public pure {
        uint160 s = MarketMath.sqrtPriceX96(c, shardIsCurrency0);
        assertGt(s, TickMath.MIN_SQRT_PRICE);
        assertLt(s, TickMath.MAX_SQRT_PRICE);
    }
}
