// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {IShardMarket} from "./interfaces/IShardMarket.sol";
import {MarketMath} from "./libraries/MarketMath.sol";

/// @notice Kura shard market and v4 hook. At settle the vault hands over a card's pool shards and its auction proceeds;
/// this contract opens a shards/USDC pool at the clearing price and keeps the liquidity positions locked for the card's
/// owner, who can collect the swap fees but never withdraw. At buyout the vault unwinds the market: the pool is frozen
/// (no swaps, no new liquidity; removing liquidity always works) and the positions' contents go to the owner.
/// @dev The hook address must carry exactly the BEFORE_INITIALIZE, BEFORE_ADD_LIQUIDITY, BEFORE_SWAP and AFTER_SWAP flags.
/// Only this contract can initialize a pool with itself as the hook, so every pool it sees is a Kura card pool.
contract ShardMarket is IShardMarket, BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    uint24 public constant FEE = 10_000; // 1 percent
    int24 public constant TICK_SPACING = 200;

    struct Market {
        PoolKey key;
        bytes32 poolId;
        address shardToken;
        address lpOwner;
        uint256 usdcDust; // USDC handed over at seed that no position could hold; paid out at unwind
        uint256[] positions;
    }

    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    address public immutable vault;
    address public immutable usdc;

    mapping(uint256 cardId => Market) internal _markets;
    mapping(bytes32 poolId => uint256 cardId) public cardIdOfPool;
    /// @dev Frozen is per pool, not per card: a card that is bought out and sharded again gets a new pool, and the old
    /// one must stay frozen.
    mapping(bytes32 poolId => bool) internal _frozen;

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(IPoolManager pm, IPositionManager posm, IAllowanceTransfer permit2_, address vault_, address usdc_) BaseHook(pm) {
        positionManager = posm;
        permit2 = permit2_;
        vault = vault_;
        usdc = usdc_;
    }

    // ---------------------------------------------------------------- vault

    /// @inheritdoc IShardMarket
    /// @dev Never reverts once the pool is initialized: a position that cannot be minted leaves its tokens here as dust
    /// for the LP owner, so the vault's settle cannot be bricked by pool math.
    function seed(uint256 cardId, address shardToken, uint256 clearingPriceQ96, address lpOwner, uint256 shardAmount, uint256 usdcAmount)
        external
        onlyVault
    {
        Market storage m = _markets[cardId];
        if (m.poolId != 0 && !_frozen[m.poolId]) revert AlreadySeeded();
        (uint160 sqrtP, int24 tick, bool shardIs0) = _openPool(m, cardId, shardToken, clearingPriceQ96, lpOwner);
        m.usdcDust = _placeLiquidity(m, sqrtP, tick, shardIs0, shardAmount, usdcAmount);
        emit PoolSeeded(cardId, m.poolId, shardToken, sqrtP, shardIs0, shardAmount, usdcAmount);
    }

    /// @dev Records the card's pool and initializes it at the clearing price.
    function _openPool(Market storage m, uint256 cardId, address shardToken, uint256 clearingPriceQ96, address lpOwner)
        internal
        returns (uint160 sqrtP, int24 tick, bool shardIs0)
    {
        shardIs0 = shardToken < usdc;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(shardIs0 ? shardToken : usdc),
            currency1: Currency.wrap(shardIs0 ? usdc : shardToken),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
        bytes32 poolId = PoolId.unwrap(key.toId());
        m.key = key;
        m.poolId = poolId;
        m.shardToken = shardToken;
        m.lpOwner = lpOwner;
        delete m.positions;
        cardIdOfPool[poolId] = cardId;

        sqrtP = MarketMath.sqrtPriceX96(clearingPriceQ96, shardIs0);
        tick = poolManager.initialize(key, sqrtP);
        _approve(shardToken);
        _approve(usdc);
    }

    /// @dev Mints the full-range position, then one-sided positions for what it could not take. Returns the USDC dust.
    function _placeLiquidity(Market storage m, uint160 sqrtP, int24 tick, bool shardIs0, uint256 shardAmount, uint256 usdcAmount)
        internal
        returns (uint256 usdcDust)
    {
        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));
        // 1. full range: as much of both as the price allows (USDC is normally the binding side)
        if (shardIs0) _mintFullRange(m, sqrtP, shardAmount, usdcAmount);
        else _mintFullRange(m, sqrtP, usdcAmount, shardAmount);
        // 2. one-sided: whatever the full range could not take
        uint256 usdcLeft = usdcAmount - (usdcBefore - IERC20(usdc).balanceOf(address(this)));
        uint256 shardLeft = IERC20(m.shardToken).balanceOf(address(this));
        // rounding leftovers of the non-binding side (<= 0.1 percent) are not worth a position; they stay as dust
        if (usdcLeft * 1000 <= usdcAmount) usdcLeft = 0;
        if (shardLeft * 1000 <= shardAmount) shardLeft = 0;
        if (shardIs0) _mintOneSided(m, tick, shardLeft, usdcLeft);
        else _mintOneSided(m, tick, usdcLeft, shardLeft);
        usdcDust = usdcAmount - (usdcBefore - IERC20(usdc).balanceOf(address(this)));
    }

    /// @inheritdoc IShardMarket
    function unwind(uint256 cardId) external onlyVault {
        Market storage m = _markets[cardId];
        bytes32 poolId = m.poolId;
        if (poolId == 0 || _frozen[poolId]) return;
        _frozen[poolId] = true;

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));
        uint256 n = m.positions.length;
        if (n > 0) {
            bytes memory actions = new bytes(n + 1);
            bytes[] memory params = new bytes[](n + 1);
            for (uint256 i; i < n; ++i) {
                actions[i] = bytes1(uint8(Actions.BURN_POSITION));
                params[i] = abi.encode(m.positions[i], uint128(0), uint128(0), bytes(""));
            }
            actions[n] = bytes1(uint8(Actions.TAKE_PAIR));
            params[n] = abi.encode(m.key.currency0, m.key.currency1, address(this));
            positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        }

        uint256 usdcOut = IERC20(usdc).balanceOf(address(this)) - usdcBefore + m.usdcDust;
        m.usdcDust = 0;
        uint256 shardOut = IERC20(m.shardToken).balanceOf(address(this)); // one shard token per sharding: all this card's
        address lpOwner = m.lpOwner;
        if (shardOut > 0) IERC20(m.shardToken).safeTransfer(lpOwner, shardOut);
        if (usdcOut > 0) IERC20(usdc).safeTransfer(lpOwner, usdcOut);
        emit Unwound(cardId, lpOwner, shardOut, usdcOut);
    }

    // ---------------------------------------------------------------- anyone

    /// @inheritdoc IShardMarket
    function collectFees(uint256 cardId) external {
        Market storage m = _markets[cardId];
        if (m.poolId == 0) revert UnknownCard();
        if (_frozen[m.poolId]) revert Frozen();
        uint256 n = m.positions.length;
        address lpOwner = m.lpOwner;
        if (n == 0) {
            emit FeesCollected(cardId, lpOwner, 0, 0);
            return;
        }

        bytes memory actions = new bytes(n + 1);
        bytes[] memory params = new bytes[](n + 1);
        for (uint256 i; i < n; ++i) {
            actions[i] = bytes1(uint8(Actions.DECREASE_LIQUIDITY));
            params[i] = abi.encode(m.positions[i], uint256(0), uint128(0), uint128(0), bytes(""));
        }
        actions[n] = bytes1(uint8(Actions.TAKE_PAIR));
        params[n] = abi.encode(m.key.currency0, m.key.currency1, lpOwner);

        uint256 shardBefore = IERC20(m.shardToken).balanceOf(lpOwner);
        uint256 usdcBefore = IERC20(usdc).balanceOf(lpOwner);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        emit FeesCollected(
            cardId,
            lpOwner,
            IERC20(m.shardToken).balanceOf(lpOwner) - shardBefore,
            IERC20(usdc).balanceOf(lpOwner) - usdcBefore
        );
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IShardMarket
    function poolKeyOf(uint256 cardId)
        external
        view
        returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
    {
        PoolKey storage k = _markets[cardId].key;
        return (Currency.unwrap(k.currency0), Currency.unwrap(k.currency1), k.fee, k.tickSpacing, address(k.hooks));
    }

    /// @inheritdoc IShardMarket
    function poolIdOf(uint256 cardId) external view returns (bytes32) {
        return _markets[cardId].poolId;
    }

    /// @inheritdoc IShardMarket
    function lpOwnerOf(uint256 cardId) external view returns (address) {
        return _markets[cardId].lpOwner;
    }

    /// @inheritdoc IShardMarket
    function isFrozen(uint256 cardId) external view returns (bool) {
        return _frozen[_markets[cardId].poolId];
    }

    /// @inheritdoc IShardMarket
    function positionsOf(uint256 cardId) external view returns (uint256[] memory) {
        return _markets[cardId].positions;
    }

    // ---------------------------------------------------------------- hook

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.afterSwap = true;
    }

    function _beforeInitialize(address sender, PoolKey calldata, uint160) internal view override returns (bytes4) {
        if (sender != address(this)) revert OnlySelf();
        return IHooks.beforeInitialize.selector;
    }

    function _beforeAddLiquidity(address, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (_frozen[PoolId.unwrap(key.toId())]) revert Frozen();
        return IHooks.beforeAddLiquidity.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (_frozen[PoolId.unwrap(key.toId())]) revert Frozen();
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @dev `delta` is the swapper's balance change (positive = received), so it maps straight onto ShardSwap.
    function _afterSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        bool shardIs0 = Currency.unwrap(key.currency1) == usdc;
        (int128 shardDelta, int128 usdcDelta) = shardIs0 ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        bytes32 poolId = PoolId.unwrap(id);
        emit ShardSwap(cardIdOfPool[poolId], poolId, shardDelta, usdcDelta, sqrtP);
        return (IHooks.afterSwap.selector, 0);
    }

    // ---------------------------------------------------------------- internals

    function _mintFullRange(Market storage m, uint160 sqrtP, uint256 a0, uint256 a1) internal {
        int24 lo = TickMath.minUsableTick(TICK_SPACING);
        int24 hi = TickMath.maxUsableTick(TICK_SPACING);
        uint128 liq =
            LiquidityAmounts.getLiquidityForAmounts(sqrtP, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), a0, a1);
        _mint(m, lo, hi, liq, a0, a1);
    }

    /// @dev Leftover currency0 goes in a range starting one spacing above the current tick, leftover currency1 in a range
    /// ending at the spacing boundary at or below it. For the shards that is always a sell wall above the shard price.
    function _mintOneSided(Market storage m, int24 tick, uint256 a0, uint256 a1) internal {
        int24 lo = TickMath.minUsableTick(TICK_SPACING);
        int24 hi = TickMath.maxUsableTick(TICK_SPACING);
        int24 floorTick = _floorTick(tick);
        int24 above = floorTick + TICK_SPACING;
        if (a0 > 0 && above < hi) {
            uint128 liq =
                LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(above), TickMath.getSqrtPriceAtTick(hi), a0);
            _mint(m, above, hi, liq, a0, 0);
        }
        if (a1 > 0 && floorTick > lo) {
            uint128 liq =
                LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(floorTick), a1);
            _mint(m, lo, floorTick, liq, 0, a1);
        }
    }

    /// @dev Mints a locked position owned by this contract. A failed mint is skipped and its tokens stay as dust.
    function _mint(Market storage m, int24 lower, int24 upper, uint128 liquidity, uint256 max0, uint256 max1) internal {
        if (liquidity == 0) return;
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(m.key, lower, upper, uint256(liquidity), _u128(max0), _u128(max1), address(this), bytes(""));
        params[1] = abi.encode(m.key.currency0, m.key.currency1);
        uint256 tokenId = positionManager.nextTokenId();
        try positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp) {
            m.positions.push(tokenId);
        } catch {}
    }

    function _approve(address token) internal {
        if (IERC20(token).allowance(address(this), address(permit2)) < type(uint128).max) {
            IERC20(token).forceApprove(address(permit2), type(uint256).max);
        }
        (uint160 amount, uint48 expiration,) = permit2.allowance(address(this), token, address(positionManager));
        if (amount < type(uint128).max || expiration != type(uint48).max) {
            permit2.approve(token, address(positionManager), type(uint160).max, type(uint48).max);
        }
    }

    function _floorTick(int24 tick) internal pure returns (int24) {
        int24 c = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) c--;
        return c * TICK_SPACING;
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        return x > type(uint128).max ? type(uint128).max : uint128(x);
    }
}
