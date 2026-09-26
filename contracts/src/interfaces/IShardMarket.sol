// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Kura shard market: one Uniswap v4 pool per settled card (shards vs USDC, 1% fee, this contract as the hook).
/// Seeded by CardVault at settle, positions locked for the card's owner, unwound to the owner at buyout.
/// @dev The ABI the indexer, the web app and the seed script build against (packages/shared abi.shardMarket).
interface IShardMarket {
    /// @notice The pool was created at the clearing price and the locked positions minted.
    /// `shardAmount`/`usdcAmount` are what the vault handed over; dust not placed in a position stays until unwind.
    event PoolSeeded(
        uint256 indexed cardId,
        bytes32 indexed poolId,
        address indexed shardToken,
        uint160 sqrtPriceX96,
        bool shardIsCurrency0,
        uint256 shardAmount,
        uint256 usdcAmount
    );

    /// @notice Emitted by the hook after every swap on a Kura pool. Deltas are the trader's balance changes:
    /// `shardDelta > 0` means the trader bought shards (and `usdcDelta < 0`); selling is the reverse.
    /// Amounts are raw units (shards 18 decimals, USDC 6). `sqrtPriceX96` is the pool price after the swap.
    event ShardSwap(uint256 indexed cardId, bytes32 indexed poolId, int256 shardDelta, int256 usdcDelta, uint160 sqrtPriceX96);

    /// @notice Swap fees on the locked positions were sent to the card's LP owner.
    event FeesCollected(uint256 indexed cardId, address indexed lpOwner, uint256 shardAmount, uint256 usdcAmount);

    /// @notice The card was bought out: the pool is frozen and the locked positions (principal + fees + dust) went to
    /// the LP owner, who claims the shards through CardVault.claimPayout.
    event Unwound(uint256 indexed cardId, address indexed lpOwner, uint256 shardAmount, uint256 usdcAmount);

    error OnlyVault();
    error OnlySelf();
    error Frozen();
    error UnknownCard();
    error AlreadySeeded();

    /// @notice Vault only. The vault has already transferred `shardAmount` shards and `usdcAmount` USDC to this
    /// contract. Creates the pool at `clearingPriceQ96` (USDC units per shard unit, Q96) and mints the locked positions.
    function seed(uint256 cardId, address shardToken, uint256 clearingPriceQ96, address lpOwner, uint256 shardAmount, uint256 usdcAmount)
        external;

    /// @notice Anyone. Sends the swap fees accrued on the card's locked positions to its LP owner.
    function collectFees(uint256 cardId) external;

    /// @notice Vault only, at redeem. Freezes the pool and sends everything in the locked positions to the LP owner.
    /// No-op for a card that was never seeded.
    function unwind(uint256 cardId) external;

    /// @notice The card's v4 pool key fields. All zero when the card has no pool.
    function poolKeyOf(uint256 cardId)
        external
        view
        returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks);

    function poolIdOf(uint256 cardId) external view returns (bytes32);
    function cardIdOfPool(bytes32 poolId) external view returns (uint256);
    function lpOwnerOf(uint256 cardId) external view returns (address);
    function isFrozen(uint256 cardId) external view returns (bool);
    /// @notice PositionManager token IDs of the locked positions (full range first, then one-sided when minted).
    function positionsOf(uint256 cardId) external view returns (uint256[] memory);
    function vault() external view returns (address);
}
