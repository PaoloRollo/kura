// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MarketTest} from "./utils/MarketTest.sol";
import {ShardToken} from "../src/ShardToken.sol";
import {IShardMarket} from "../src/interfaces/IShardMarket.sol";
import {MarketMath} from "../src/libraries/MarketMath.sol";

contract ShardMarketSeedTest is MarketTest {
    using StateLibrary for IPoolManager;

    uint256 constant CARD = 7;
    /// A typical graduated settle: 8 held + 5.5 unsold shards, 25 USDC raised minus a 2.5 percent fee, clearing at $10.
    uint256 constant SHARDS = 135e17;
    uint256 constant NET_USDC = 24_375_000;

    function _slot0(uint256 cardId) internal view returns (uint160 sqrtP, int24 tick) {
        (sqrtP, tick,,) = manager.getSlot0(PoolId.wrap(mkt.poolIdOf(cardId)));
    }

    function _shardSide(BalanceDelta d, bool shardIs0) internal pure returns (int128 shard, int128 cash) {
        return shardIs0 ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
    }

    // ------------------------------------------------------------ seeding at the clearing price

    function test_seedOpensAtClearingPrice_shardBelowUsdc() public {
        _checkOpensAtClearing(true);
    }

    function test_seedOpensAtClearingPrice_shardAboveUsdc() public {
        _checkOpensAtClearing(false);
    }

    function _checkOpensAtClearing(bool below) internal {
        ShardToken t = _shardToken(below);
        t.mint(address(mkt), SHARDS);
        usdc.mint(address(mkt), NET_USDC);
        vm.expectEmit(true, false, true, true, address(mkt)); // pool id is checked below
        emit IShardMarket.PoolSeeded(CARD, bytes32(0), address(t), MarketMath.sqrtPriceX96(_q96(10e6), below), below, SHARDS, NET_USDC);
        mkt.seed(CARD, address(t), _q96(10e6), lp, SHARDS, NET_USDC);

        assertEq(_shardIs0(CARD), below, "currency order follows the shard address");
        PoolKey memory k = _key(CARD);
        assertEq(mkt.poolIdOf(CARD), PoolId.unwrap(k.toId()));
        assertEq(mkt.cardIdOfPool(mkt.poolIdOf(CARD)), CARD);
        assertEq(k.fee, 10_000);
        assertEq(k.tickSpacing, 200);
        assertEq(address(k.hooks), address(mkt));
        assertEq(mkt.lpOwnerOf(CARD), lp);
        assertFalse(mkt.isFrozen(CARD));

        (uint160 sqrtP, int24 tick) = _slot0(CARD);
        assertEq(sqrtP, MarketMath.sqrtPriceX96(_q96(10e6), below));
        assertEq(tick, TickMath.getTickAtSqrtPrice(sqrtP));

        uint256[] memory pos = mkt.positionsOf(CARD);
        assertEq(pos.length, 2, "full range + shard wall");
        assertEq(IERC721(address(posm)).ownerOf(pos[0]), address(mkt));
        assertEq(IERC721(address(posm)).ownerOf(pos[1]), address(mkt));
        assertLe(usdc.balanceOf(address(mkt)), 1, "USDC is the binding side, all of it is placed");
        assertLe(t.balanceOf(address(mkt)), 1e6, "shards all placed but rounding dust");

        // a small buy pays the clearing price plus the 1 percent fee
        usdc.mint(trader, 10_000);
        BalanceDelta d = _swap(trader, CARD, true, 10_000);
        (int128 shardOut, int128 cashIn) = _shardSide(d, below);
        assertEq(cashIn, -10_000);
        uint256 paidPerShard = 10_000 * 1e18 / uint256(int256(shardOut));
        assertApproxEqRel(paidPerShard, uint256(10e6) * 100 / 99, 1e15, "clearing price + fee, within a tick");
    }

    // ------------------------------------------------------------ thin or empty proceeds

    function test_zeroUsdcSeedsOnlyTheShardWall() public {
        _checkZeroUsdc(true);
        _checkZeroUsdc(false);
    }

    function _checkZeroUsdc(bool below) internal {
        uint256 card = below ? 1 : 2;
        ShardToken t = _shardToken(below);
        _seed(card, t, 10e6, 16e18, 0);
        uint256[] memory pos = mkt.positionsOf(card);
        assertEq(pos.length, 1, "no full range without USDC");
        assertLe(t.balanceOf(address(mkt)), 1e6, "shards all in the wall");
        assertEq(mkt.poolIdOf(card), PoolId.unwrap(_key(card).toId()));

        // buyers still get shards, at or above the clearing price
        usdc.mint(trader, 1e6);
        BalanceDelta d = _swap(trader, card, true, 1e6);
        (int128 shardOut,) = _shardSide(d, below);
        assertGt(shardOut, 0);
        assertLe(uint256(int256(shardOut)), 1e18 * 99 / 1000, "1 USDC buys at most 0.099 shards at $10 + fee");
    }

    function test_oneUnitOfUsdcDoesNotRevert() public {
        ShardToken a = _shardToken(true);
        _seed(1, a, 10e6, SHARDS, 1);
        ShardToken b = _shardToken(false);
        _seed(2, b, 10e6, SHARDS, 1);
        assertGe(mkt.positionsOf(1).length, 1);
        assertGe(mkt.positionsOf(2).length, 1);
        assertLe(a.balanceOf(address(mkt)), 1e6);
        assertLe(b.balanceOf(address(mkt)), 1e6);
    }

    function test_extremeClearingPricesDoNotRevert() public {
        _seed(1, _shardToken(true), 1, SHARDS, 1); // $0.000001 per shard
        _seed(2, _shardToken(false), 1, SHARDS, 1);
        _seed(3, _shardToken(true), 1_000_000e6, SHARDS, 1_000_000e6);
        _seed(4, _shardToken(false), 1_000_000e6, SHARDS, 1_000_000e6);
        ShardToken z = _shardToken(true);
        z.mint(address(mkt), SHARDS);
        mkt.seed(5, address(z), 0, lp, SHARDS, 0); // zero clearing price clamps to the lowest price
        for (uint256 i = 1; i <= 4; i++) {
            assertGe(mkt.positionsOf(i).length, 1);
        }
    }

    // ------------------------------------------------------------ access

    function test_onlyTheMarketCanInitializeAPoolWithItsHook() public {
        ShardToken t = _shardToken(true);
        PoolKey memory k = PoolKey(Currency.wrap(address(t)), Currency.wrap(USDC_ADDR), 10_000, 200, IHooks(address(mkt)));
        vm.expectRevert(); // OnlySelf, wrapped by the PoolManager
        manager.initialize(k, MarketMath.sqrtPriceX96(_q96(10e6), true));
    }

    function test_seedIsVaultOnlyAndOnce() public {
        ShardToken t = _shardToken(true);
        vm.prank(trader);
        vm.expectRevert(IShardMarket.OnlyVault.selector);
        mkt.seed(CARD, address(t), _q96(10e6), lp, 0, 0);

        _seed(CARD, t, 10e6, SHARDS, NET_USDC);
        ShardToken t2 = _shardToken(true);
        vm.expectRevert(IShardMarket.AlreadySeeded.selector);
        mkt.seed(CARD, address(t2), _q96(10e6), lp, 0, 0);

        vm.prank(trader);
        vm.expectRevert(IShardMarket.OnlyVault.selector);
        mkt.unwind(CARD);
    }

    function test_hookPermissionsMatchTheAddress() public view {
        assertEq(uint160(address(mkt)) & 0x3fff, FLAGS);
        assertEq(mkt.vault(), address(this));
    }

    // ------------------------------------------------------------ ShardSwap

    function test_shardSwapSigns_shardBelowUsdc() public {
        _checkSwapEvents(true);
    }

    function test_shardSwapSigns_shardAboveUsdc() public {
        _checkSwapEvents(false);
    }

    function _checkSwapEvents(bool below) internal {
        ShardToken t = _shardToken(below);
        _seed(CARD, t, 10e6, SHARDS, NET_USDC);
        bytes32 poolId = mkt.poolIdOf(CARD);

        // buy: USDC in, shards out
        usdc.mint(trader, 1e6);
        vm.recordLogs();
        BalanceDelta d = _swap(trader, CARD, true, 1e6);
        (int256 shardDelta, int256 usdcDelta, uint160 sqrtAfter) = _lastShardSwap(poolId);
        (int128 shardD, int128 cashD) = _shardSide(d, below);
        assertEq(shardDelta, shardD);
        assertEq(usdcDelta, cashD);
        assertGt(shardDelta, 0, "buyer receives shards");
        assertEq(usdcDelta, -1e6, "buyer pays USDC");
        (uint160 sqrtP,) = _slot0(CARD);
        assertEq(sqrtAfter, sqrtP);
        assertEq(t.balanceOf(trader), uint256(shardDelta));

        // sell: shards in, USDC out
        uint256 sellAmt = uint256(shardDelta) / 2;
        vm.recordLogs();
        d = _swap(trader, CARD, false, sellAmt);
        (shardDelta, usdcDelta,) = _lastShardSwap(poolId);
        (shardD, cashD) = _shardSide(d, below);
        assertEq(shardDelta, shardD);
        assertEq(usdcDelta, cashD);
        assertEq(shardDelta, -int256(sellAmt), "seller pays shards");
        assertGt(usdcDelta, 0, "seller receives USDC");
    }

    function _lastShardSwap(bytes32 poolId) internal view returns (int256 shardDelta, int256 usdcDelta, uint160 sqrtP) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = IShardMarket.ShardSwap.selector;
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(mkt) && l.topics[0] == sig) {
                assertEq(uint256(l.topics[1]), CARD);
                assertEq(l.topics[2], poolId);
                return abi.decode(l.data, (int256, int256, uint160));
            }
        }
        revert("no ShardSwap");
    }
}

contract ShardMarketUnwindTest is MarketTest {
    using StateLibrary for IPoolManager;

    uint256 constant CARD = 7;
    uint256 constant SHARDS = 135e17;
    uint256 constant NET_USDC = 24_375_000;

    address outsider = makeAddr("outsider");
    ShardToken t;

    function setUp() public override {
        super.setUp();
        t = _shardToken(true);
        _seed(CARD, t, 10e6, SHARDS, NET_USDC);
    }

    function _trade() internal {
        usdc.mint(trader, 5e6);
        BalanceDelta d = _swap(trader, CARD, true, 5e6); // buy ~0.49 shards
        _swap(trader, CARD, false, uint256(int256(d.amount0())) / 2); // sell half back
    }

    function test_collectFeesPaysTheLpOwner() public {
        _trade();
        vm.recordLogs();
        vm.prank(trader); // anyone may collect
        mkt.collectFees(CARD);
        uint256 usdcFee = usdc.balanceOf(lp);
        uint256 shardFee = t.balanceOf(lp);
        assertApproxEqRel(usdcFee, 5e6 / 100, 1e16, "1 percent of the 5 USDC buy");
        assertGt(shardFee, 0, "fee on the shard sell");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory l = logs[logs.length - 1];
        assertEq(l.topics[0], IShardMarket.FeesCollected.selector);
        assertEq(uint256(l.topics[1]), CARD);
        assertEq(address(uint160(uint256(l.topics[2]))), lp);
        (uint256 s, uint256 u) = abi.decode(l.data, (uint256, uint256));
        assertEq(s, shardFee);
        assertEq(u, usdcFee);

        // nothing more until the next trade, and liquidity is untouched
        mkt.collectFees(CARD);
        assertEq(usdc.balanceOf(lp), usdcFee);
        assertGt(manager.getLiquidity(PoolId.wrap(mkt.poolIdOf(CARD))), 0);
    }

    function test_collectFeesUnknownCard() public {
        vm.expectRevert(IShardMarket.UnknownCard.selector);
        mkt.collectFees(99);
    }

    function test_unwindFreezesAndPaysTheLpOwner() public {
        _trade();
        uint256[] memory pos = mkt.positionsOf(CARD);

        vm.expectEmit(true, true, false, false, address(mkt));
        emit IShardMarket.Unwound(CARD, lp, 0, 0);
        mkt.unwind(CARD);

        assertTrue(mkt.isFrozen(CARD));
        assertEq(t.balanceOf(address(mkt)), 0, "every shard of the card leaves");
        assertEq(usdc.balanceOf(address(mkt)), 0, "every USDC of the card leaves");
        // the LP owner got the whole pool: principal, both trades' fees and dust
        assertEq(t.balanceOf(lp) + t.balanceOf(trader) + t.balanceOf(address(manager)), SHARDS, "shards conserved");
        assertLe(t.balanceOf(address(manager)), 10, "only rounding dust stays in the PoolManager");
        assertEq(usdc.balanceOf(lp) + usdc.balanceOf(trader) + usdc.balanceOf(address(manager)), NET_USDC + 5e6, "USDC conserved");
        assertLe(usdc.balanceOf(address(manager)), 10);
        for (uint256 i; i < pos.length; i++) {
            vm.expectRevert();
            IERC721(address(posm)).ownerOf(pos[i]);
        }

        // swaps and new liquidity revert (Frozen, wrapped by the PoolManager)
        usdc.mint(trader, 1e6);
        vm.expectRevert();
        this.swapFor(trader, true, 1e6);
        vm.expectRevert();
        this.outsideFor(outsider, 1e15, bytes32(0));
        vm.expectRevert(IShardMarket.Frozen.selector);
        mkt.collectFees(CARD);

        // a second unwind is a no-op
        uint256 lpBal = t.balanceOf(lp);
        mkt.unwind(CARD);
        assertEq(t.balanceOf(lp), lpBal);
    }

    function test_outsideLiquidityLeavesAfterFreeze() public {
        t.mint(outsider, 5e18);
        usdc.mint(outsider, 100e6);
        _outsideLiquidity(outsider, CARD, 1e12, bytes32("o"));
        uint256 shardsIn = 5e18 - t.balanceOf(outsider);
        assertGt(shardsIn, 0);

        mkt.unwind(CARD);

        _outsideLiquidity(outsider, CARD, -1e12, bytes32("o"));
        assertApproxEqAbs(t.balanceOf(outsider), 5e18, 2, "outside LP gets its shards back after the freeze");
        assertApproxEqAbs(usdc.balanceOf(outsider), 100e6, 2);
    }

    function test_unwindNeverTouchesAnotherCard() public {
        ShardToken t2 = _shardToken(false);
        _seed(8, t2, 20e6, SHARDS, 50e6);
        uint256 usdcBefore = usdc.balanceOf(address(mkt));
        uint256 t2Before = t2.balanceOf(address(mkt));
        mkt.unwind(CARD);
        assertEq(usdc.balanceOf(address(mkt)), usdcBefore, "card 8's USDC dust stays");
        assertEq(t2.balanceOf(address(mkt)), t2Before);
        assertFalse(mkt.isFrozen(8));
        usdc.mint(trader, 1e6);
        _swap(trader, 8, true, 1e6); // card 8 still trades
    }

    function test_unwindOfUnseededCardIsNoop() public {
        mkt.unwind(99);
        assertFalse(mkt.isFrozen(99));
    }

    /// A bought-out card can be sharded again: the new pool trades, the old one stays frozen.
    function test_reseedAfterUnwindKeepsTheOldPoolFrozen() public {
        PoolKey memory oldKey = _key(CARD);
        mkt.unwind(CARD);
        ShardToken t2 = _shardToken(false);
        _seed(CARD, t2, 10e6, SHARDS, NET_USDC);
        assertFalse(mkt.isFrozen(CARD));
        assertTrue(mkt.poolIdOf(CARD) != PoolId.unwrap(oldKey.toId()));

        usdc.mint(trader, 2e6);
        _swap(trader, CARD, true, 1e6);
        vm.startPrank(trader);
        usdc.approve(address(swapRouter), 1e6);
        vm.expectRevert();
        swapRouter.swap(
            oldKey,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -1e6, sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    // external wrappers so vm.expectRevert can target a single call
    function swapFor(address who, bool buy, uint256 amt) external {
        _swap(who, CARD, buy, amt);
    }

    function outsideFor(address who, int256 liq, bytes32 salt) external {
        _outsideLiquidity(who, CARD, liq, salt);
    }
}
