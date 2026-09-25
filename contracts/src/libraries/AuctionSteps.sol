// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Encodes a linear CCA release schedule as two packed steps.
/// Each step is a bytes8 matching Uniswap's StepLib: high 24 bits = MPS per block (1e7 MPS = 100 percent),
/// low 40 bits = block span. Two steps are needed because 1e7 is not divisible by every duration; the last block
/// absorbs the remainder so that sum(mps * span) == 1e7 and sum(span) == duration exactly.
library AuctionSteps {
    uint256 internal constant MPS_TOTAL = 1e7;
    uint40 internal constant MIN_DURATION = 2;
    uint40 internal constant MAX_DURATION = 1_000_000;

    /// @notice Thrown when `linear` is called with a duration outside [MIN_DURATION, MAX_DURATION].
    error DurationOutOfRange();

    /// @notice Builds a two-step linear release schedule spanning `durationBlocks` blocks.
    /// @dev Encodes each step as a packed bytes8 (StepLib layout: high 24 bits mps, low 40 bits blockDelta).
    /// The first step covers `durationBlocks - 1` blocks at the floor MPS-per-block rate; the final one-block
    /// step absorbs the remainder so the schedule sums to exactly 1e7 MPS over exactly `durationBlocks` blocks.
    /// @param durationBlocks Number of blocks the auction should span; must be in [2, 1_000_000].
    /// @return Packed bytes containing the two encoded steps, ready for the CCA's StepLib to parse.
    function linear(uint40 durationBlocks) internal pure returns (bytes memory) {
        if (durationBlocks < MIN_DURATION || durationBlocks > MAX_DURATION) revert DurationOutOfRange();
        uint24 perBlock = uint24(MPS_TOTAL / durationBlocks);
        uint40 firstSpan = durationBlocks - 1;
        uint24 last = uint24(MPS_TOTAL - uint256(perBlock) * firstSpan);
        return abi.encodePacked(_step(perBlock, firstSpan), _step(last, 1));
    }

    /// @notice Packs an MPS rate and block span into a single StepLib-compatible bytes8.
    /// @param mps MPS released per block in this step (high 24 bits).
    /// @param blockSpan Number of blocks this step covers (low 40 bits).
    /// @return The packed step.
    function _step(uint24 mps, uint40 blockSpan) private pure returns (bytes8) {
        return bytes8((uint64(mps) << 40) | uint64(blockSpan));
    }
}
