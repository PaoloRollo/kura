// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";

contract PriceMathTest is Test {
    function test_roundTrip_tenUsdc() public pure {
        uint256 usdc = 10_000_000; // 10 USDC per whole shard
        uint256 q96 = PriceMath.usdcPerShardToQ96(usdc);
        assertGt(q96, 2 ** 32 + 1, "above CCA MIN_FLOOR_PRICE");
        assertEq(PriceMath.q96ToUsdcPerShard(q96), usdc);
    }

    function test_roundTrip_oneUnit() public pure {
        uint256 q96 = PriceMath.usdcPerShardToQ96(1);
        assertGt(q96, 2 ** 32 + 1);
        assertEq(PriceMath.q96ToUsdcPerShard(q96), 1);
    }

    function testFuzz_roundTrip(uint256 usdc) public pure {
        usdc = bound(usdc, 1, 1e15); // up to one billion USDC per shard
        assertEq(PriceMath.q96ToUsdcPerShard(PriceMath.usdcPerShardToQ96(usdc)), usdc);
    }

    function test_payoutFor_wholeAndFractionalShards() public pure {
        // 10 USDC per shard, 3 shards -> 30 USDC
        assertEq(PriceMath.payoutFor(10_000_000, 3e18), 30_000_000);
        // 10 USDC per shard, 2.5 shards -> 25 USDC
        assertEq(PriceMath.payoutFor(10_000_000, 25e17), 25_000_000);
        // rounding down: 1 unit per shard, 0.9 shard -> 0
        assertEq(PriceMath.payoutFor(1, 9e17), 0);
    }
}
