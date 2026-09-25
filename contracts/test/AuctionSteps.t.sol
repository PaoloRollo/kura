// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AuctionSteps} from "../src/libraries/AuctionSteps.sol";

/// @dev AuctionSteps.linear is `internal`, so Solidity inlines it into the caller instead of emitting a
/// CALL/DELEGATECALL. `vm.expectRevert` only intercepts reverts that occur in a deeper call frame, so calling
/// the internal function directly from the test would never trigger it. This external wrapper gives the revert
/// a real call boundary to cross, matching the pattern the CCA's own test suite uses for its internal libraries
/// (see lib/continuous-clearing-auction/test/btt/libraries/auctionStepLib/parse.t.sol's AuctionStepWrapper).
contract AuctionStepsHarness {
    function linear(uint40 durationBlocks) external pure returns (bytes memory) {
        return AuctionSteps.linear(durationBlocks);
    }
}

contract AuctionStepsTest is Test {
    uint256 constant MPS_TOTAL = 1e7;

    AuctionStepsHarness harness = new AuctionStepsHarness();

    function _decode(bytes memory data) internal pure returns (uint64[] memory mps, uint64[] memory blocks) {
        uint256 n = data.length / 8;
        mps = new uint64[](n);
        blocks = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes8 word;
            assembly {
                word := mload(add(add(data, 32), mul(i, 8)))
            }
            // CCA StepLib.parse: mps = uint24(bytes3(data)) (high 24 bits), blockDelta = uint40(uint64(data)) (low 40 bits)
            mps[i] = uint24(bytes3(word));
            blocks[i] = uint40(uint64(word));
        }
    }

    function test_linear_twoBlocks() public pure {
        (uint64[] memory mps, uint64[] memory blocks) = _decode(AuctionSteps.linear(2));
        assertEq(mps.length, 2);
        assertEq(mps[0], 5_000_000);
        assertEq(blocks[0], 1);
        assertEq(mps[1], 5_000_000);
        assertEq(blocks[1], 1);
    }

    function test_linear_sevenBlocks_sumsExactly() public pure {
        (uint64[] memory mps, uint64[] memory blocks) = _decode(AuctionSteps.linear(7));
        uint256 total;
        uint256 span;
        for (uint256 i = 0; i < mps.length; i++) {
            total += uint256(mps[i]) * blocks[i];
            span += blocks[i];
        }
        assertEq(total, MPS_TOTAL);
        assertEq(span, 7);
    }

    function testFuzz_linear_invariants(uint40 duration) public pure {
        duration = uint40(bound(duration, 2, 1_000_000));
        (uint64[] memory mps, uint64[] memory blocks) = _decode(AuctionSteps.linear(duration));
        uint256 total;
        uint256 span;
        for (uint256 i = 0; i < mps.length; i++) {
            assertGt(mps[i], 0, "mps must be positive");
            assertLt(mps[i], 1 << 24, "mps must fit 24 bits");
            assertGt(blocks[i], 0, "block span must be positive");
            total += uint256(mps[i]) * blocks[i];
            span += blocks[i];
        }
        assertEq(total, MPS_TOTAL, "must release exactly 100 percent");
        assertEq(span, duration, "must span exactly the duration");
    }

    function test_linear_rejectsTooShortOrTooLong() public {
        vm.expectRevert(AuctionSteps.DurationOutOfRange.selector);
        harness.linear(1);
        vm.expectRevert(AuctionSteps.DurationOutOfRange.selector);
        harness.linear(1_000_001);
    }
}
