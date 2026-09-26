// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkTest} from "./utils/ForkTest.sol";
import {CardVault} from "../src/CardVault.sol";
import {ShardToken} from "../src/ShardToken.sol";
import {Tickets} from "../src/libraries/Tickets.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {ICCAAuction} from "../src/interfaces/ICCA.sol";
import {ShardMarket} from "../src/ShardMarket.sol";
import {MarketMath} from "../src/libraries/MarketMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/// End-to-end walk of a card's life: mint, a first sharding sold and bought out, a second sharding on the same
/// card, the first sharding's minority holders claiming their payout after the card has already moved on, a second
/// buyout, and finally the vendor releasing the physical card. Mirrors CardVault.redeem.t.sol's setup and helpers.
/// @dev State that crosses steps lives in storage rather than as locals in one giant test function, to stay clear
/// of "stack too deep" with this many memory structs in play.
contract CardVaultLifecycleTest is ForkTest {
    /// The CCA floor is a Q96 price rounded up, so fills land a few wei of shard units short of the exact figures.
    /// Expected amounts are derived from on-chain balances; only the round-figure shard comparisons use this
    /// tolerance, never USDC payout amounts computed from an actual balance.
    uint256 constant DUST = 100;

    uint256 id;
    address shardToken1;
    address auction1;
    address shardToken2;
    address auction2;
    uint256 payout1;
    uint256 bobShards1;
    uint256 carolShards1;

    function setUp() public override {
        super.setUp();
        id = _mintTo(alice);
    }

    /// Shards `cardId`, has bob and carol bid, settles, and lets them claim their auction tokens. Mirrors
    /// CardVaultRedeemTest._runAuction.
    function _runAuction(uint256 cardId, CardVault.ShardParams memory p) internal returns (address t, address a) {
        vm.prank(alice);
        (t, a) = vault.shardAndAuction(cardId, p);
        uint256 tick = ICCAAuction(a).tickSpacing();
        uint256 bobBid = _bid(bob, a, tick * 22, 10e6);
        uint256 carolBid = _bid(carol, a, tick * 24, 15e6);
        vm.roll(ICCAAuction(a).endBlock());
        vault.settle(cardId);
        _buyPool(t, alice); // alice buys every shard the settle put in the pool
        vm.prank(bob);
        ICCAAuction(a).exitBid(bobBid);
        vm.prank(carol);
        ICCAAuction(a).exitBid(carolBid);
        ICCAAuction(a).claimTokens(bobBid);
        ICCAAuction(a).claimTokens(carolBid);
    }

    function _fundAndApprove(address who, uint256 amount) internal {
        _dealUsdc(who, amount);
        vm.prank(who);
        USDC.approve(address(vault), amount);
    }

    /// @dev USDC `redeemer` owes to buy out everyone else in `token` at `price`: (payout, fee).
    function _owed(address token, address redeemer, uint256 price) internal view returns (uint256 p, uint256 fee) {
        uint256 missing = ShardToken(token).totalSupply() - ShardToken(token).balanceOf(redeemer);
        p = PriceMath.payoutFor(price, missing);
        fee = p * 250 / 10_000;
    }

    /// @dev Buys out `redeemer`'s minority on `token` at `pricePerShard`, funding and approving first.
    function _redeemAt(uint256 cardId, address token, uint256 pricePerShard) internal returns (uint256 pool) {
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(cardId, token, pricePerShard);
        uint256 fee;
        (pool, fee) = _owed(token, alice, pricePerShard);
        _fundAndApprove(alice, pool + fee);
        vm.prank(alice);
        vault.redeem(cardId, a, sig);
    }

    function test_fullLifecycleAcrossReShardingAndRelease() public {
        _step1_mint();
        _step2_shardAndAuction();
        _step3_redeemFirstSharding();
        _step4_reShardAndAuctionAgain();
        _step5_minorityClaimsOnFirstShardToken();
        _step6_redeemSecondSharding();
        _step7_confirmRelease();
    }

    function _step1_mint() internal {
        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Whole));
        assertEq(vault.ownerOf(id), alice);
    }

    function _step2_shardAndAuction() internal {
        (shardToken1, auction1) = _runAuction(id, _defaultParams());
        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Sharded));
        assertEq(c.shardToken, shardToken1);
        assertTrue(vault.shardings(shardToken1).settled);
    }

    function _step3_redeemFirstSharding() internal {
        // record bob and carol's minority balances of the first shard token before alice buys them out
        bobShards1 = ShardToken(shardToken1).balanceOf(bob);
        carolShards1 = ShardToken(shardToken1).balanceOf(carol);
        assertApproxEqAbs(bobShards1, 1e18, DUST);
        assertApproxEqAbs(carolShards1, 15e17, DUST);

        payout1 = _redeemAt(id, shardToken1, 12e6);

        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Whole));
        assertEq(vault.ownerOf(id), alice);
        assertEq(c.beneficialOwner, alice);
        assertEq(vault.shardings(shardToken1).redeemer, alice);
        assertEq(vault.shardings(shardToken1).buyoutPerShard, 12e6);
        assertEq(vault.shardings(shardToken1).payoutPool, payout1);
    }

    function _step4_reShardAndAuctionAgain() internal {
        (shardToken2, auction2) = _runAuction(id, _defaultParams());
        assertTrue(shardToken2 != shardToken1, "second sharding mints a fresh shard token");
        assertTrue(auction2 != auction1, "second sharding opens a fresh auction");

        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Sharded));
        assertEq(c.shardToken, shardToken2);
        assertTrue(vault.shardings(shardToken2).settled);
    }

    /// Minority holders of the FIRST shard token still claim successfully, even though the card has since moved
    /// through a second sharding. Amounts are derived from the balances recorded in step 3, as the redeem tests do.
    function _step5_minorityClaimsOnFirstShardToken() internal {
        uint256 bobOwed = PriceMath.payoutFor(12e6, bobShards1);
        uint256 bobUsdcBefore = USDC.balanceOf(bob);
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit CardVault.PayoutClaimed(id, shardToken1, bob, bobShards1, bobOwed);
        vault.claimPayout(shardToken1);
        assertEq(USDC.balanceOf(bob) - bobUsdcBefore, bobOwed);
        assertEq(ShardToken(shardToken1).balanceOf(bob), 0, "bob's first-sharding shards burned");

        uint256 carolOwed = PriceMath.payoutFor(12e6, carolShards1);
        uint256 carolUsdcBefore = USDC.balanceOf(carol);
        vm.prank(carol);
        vault.claimPayout(shardToken1);
        assertEq(USDC.balanceOf(carol) - carolUsdcBefore, carolOwed);
        assertEq(ShardToken(shardToken1).balanceOf(carol), 0, "carol's first-sharding shards burned");

        assertEq(vault.shardings(shardToken1).payoutPool, payout1 - bobOwed - carolOwed);
    }

    function _step6_redeemSecondSharding() internal {
        _redeemAt(id, shardToken2, 12e6);

        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Whole));
        assertEq(vault.ownerOf(id), alice);
        assertEq(vault.shardings(shardToken2).redeemer, alice);
        assertEq(vault.shardings(shardToken2).buyoutPerShard, 12e6);
    }

    function _step7_confirmRelease() internal {
        (Tickets.Ticket memory t, bytes memory sig) = _passportTicket(alice, 777);
        vm.prank(vendor);
        vm.expectEmit(true, true, true, true);
        emit CardVault.CardReleased(id, alice);
        vault.confirmRelease(id, t, sig);

        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Released));
        assertTrue(names.revoked(id));
        assertEq(vault.ownerOf(id), alice, "NFT stays with the holder as a record");
    }
}

/// The same life through the real ShardMarket on Sepolia's Uniswap v4 (PoolManager, PositionManager, Permit2): the
/// auction seeds the pool, an outside LP joins, a buyer reaches 80 percent by buying from the pool and redeems, the pool
/// freezes, the outside LP leaves, and every holder, the LP owner included, claims.
contract CardVaultMarketLifecycleTest is ForkTest {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    address constant POSM = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    uint160 constant FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
    uint256 constant DUST = 100;

    ShardMarket sm;
    PoolSwapTest router;
    PoolModifyLiquidityTest lpRouter;
    address dave = makeAddr("dave"); // outside LP
    address erin = makeAddr("erin"); // buys from the pool to reach 80 percent

    uint256 id;
    address shardToken;
    address auction;
    bool shardIs0;
    int256 daveLiq;

    function _deployMarket() internal override returns (address) {
        address at = address(FLAGS | (uint160(0x4b17) << 144));
        deployCodeTo("ShardMarket.sol:ShardMarket", abi.encode(PM, POSM, PERMIT2, address(vault), address(USDC)), at);
        sm = ShardMarket(at);
        return at;
    }

    function setUp() public override {
        super.setUp();
        router = new PoolSwapTest(PM);
        lpRouter = new PoolModifyLiquidityTest(PM);
        id = _mintTo(alice);
    }

    function _key() internal view returns (PoolKey memory k) {
        (address c0, address c1, uint24 fee, int24 spacing, address hooks) = sm.poolKeyOf(id);
        k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(hooks));
    }

    function test_marketLifecycle() public {
        _runLifecycle(13e18, 1e18);
    }

    /// forge-config: default.fuzz.runs = 16
    function testFuzz_payoutPoolCoversEveryClaim(uint256 erinBuys, uint256 daveShards) public {
        erinBuys = bound(erinBuys, 128e17, 133e17); // from exactly 80 percent of the supply to most of the pool
        daveShards = bound(daveShards, 1e16, 15e17);
        _runLifecycle(erinBuys, daveShards);
    }

    function _runLifecycle(uint256 erinBuys, uint256 daveShards) internal {
        _auctionAndSettle();
        _outsideLpJoins(daveShards);
        _erinBuysFromThePool(erinBuys);
        _erinRedeems();
        _poolIsFrozen();
        _everyoneClaims();
    }

    function _auctionAndSettle() internal {
        vm.prank(alice);
        (shardToken, auction) = vault.shardAndAuction(id, _defaultParams());
        uint256 tick = ICCAAuction(auction).tickSpacing();
        uint256 bobBid = _bid(bob, auction, tick * 22, 10e6);
        uint256 carolBid = _bid(carol, auction, tick * 24, 15e6);
        vm.roll(ICCAAuction(auction).endBlock());
        vault.settle(id);

        uint256 clearing = vault.shardings(shardToken).clearingPriceQ96;
        shardIs0 = shardToken < address(USDC);
        (uint160 sqrtP,,,) = PM.getSlot0(PoolId.wrap(sm.poolIdOf(id)));
        assertEq(sqrtP, MarketMath.sqrtPriceX96(clearing, shardIs0), "pool opens at the clearing price");
        assertEq(sm.positionsOf(id).length, 2, "full range + shard wall");
        assertEq(sm.lpOwnerOf(id), alice);
        assertEq(ShardToken(shardToken).balanceOf(address(vault)), 0);
        assertEq(ShardToken(shardToken).balanceOf(alice), 0);
        assertApproxEqAbs(ShardToken(shardToken).balanceOf(address(PM)), 135e17, 1e6, "8 held + 5.5 unsold in the pool");

        vm.prank(bob);
        ICCAAuction(auction).exitBid(bobBid);
        vm.prank(carol);
        ICCAAuction(auction).exitBid(carolBid);
        ICCAAuction(auction).claimTokens(bobBid);
        ICCAAuction(auction).claimTokens(carolBid);
    }

    function _outsideLpJoins(uint256 daveShards) internal {
        // dave buys his shards from the pool, then provides them full range with matching USDC
        _dealUsdc(dave, 1_000e6);
        _swapExactOut(dave, daveShards);
        (uint160 sqrtP,,,) = PM.getSlot0(PoolId.wrap(sm.poolIdOf(id)));
        uint256 bal = ShardToken(shardToken).balanceOf(dave);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(-887200),
            TickMath.getSqrtPriceAtTick(887200),
            shardIs0 ? bal : USDC.balanceOf(dave),
            shardIs0 ? USDC.balanceOf(dave) : bal
        );
        daveLiq = int256(uint256(liq));
        _daveLiquidity(daveLiq);
        assertLt(ShardToken(shardToken).balanceOf(dave), bal, "dave's shards are in the pool");
    }

    function _erinBuysFromThePool(uint256 amount) internal {
        _dealUsdc(erin, 10_000_000e6);
        uint256 spent = USDC.balanceOf(erin);
        _swapExactOut(erin, amount);
        spent -= USDC.balanceOf(erin);
        assertEq(ShardToken(shardToken).balanceOf(erin), amount);
        assertGt(spent, amount * 10e6 / 1e18, "the pool price rises as erin buys");
    }

    function _erinRedeems() internal {
        uint256 aliceUsdc = USDC.balanceOf(alice);
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 12e6);
        uint256 missing = ShardToken(shardToken).totalSupply() - ShardToken(shardToken).balanceOf(erin);
        uint256 owed = PriceMath.payoutFor(12e6, missing);
        vm.prank(erin);
        USDC.approve(address(vault), owed + owed * 250 / 10_000);
        vm.prank(erin);
        vault.redeem(id, a, sig);

        assertEq(vault.ownerOf(id), erin);
        assertTrue(sm.isFrozen(id));
        assertGt(ShardToken(shardToken).balanceOf(alice), 0, "pool shards returned to the LP owner");
        assertGt(USDC.balanceOf(alice) - aliceUsdc, 24e6, "seed USDC plus what the buyers paid");
        assertEq(ShardToken(shardToken).balanceOf(address(sm)), 0);
        assertEq(USDC.balanceOf(address(sm)), 0);
    }

    function _poolIsFrozen() internal {
        _dealUsdc(bob, 10e6);
        vm.expectRevert();
        this.swapExactIn(bob, 1e6);
        vm.expectRevert();
        this.daveLiquidity(daveLiq);
        // removing always works
        _daveLiquidity(-daveLiq);
        assertGt(ShardToken(shardToken).balanceOf(dave), 0);
    }

    function _everyoneClaims() internal {
        ShardToken t = ShardToken(shardToken);
        address[4] memory holders = [alice, bob, carol, dave];
        uint256 pool = vault.shardings(shardToken).payoutPool;
        for (uint256 i; i < holders.length; i++) {
            uint256 bal = t.balanceOf(holders[i]);
            if (bal == 0) continue;
            uint256 before = USDC.balanceOf(holders[i]);
            vm.prank(holders[i]);
            vault.claimPayout(shardToken);
            assertEq(USDC.balanceOf(holders[i]) - before, PriceMath.payoutFor(12e6, bal));
            pool -= PriceMath.payoutFor(12e6, bal);
        }
        assertEq(vault.shardings(shardToken).payoutPool, pool);
        assertEq(USDC.balanceOf(address(vault)), pool, "the vault holds nothing but the unclaimed dust's payout");
        // left: the auction's rounding dust and the PoolManager's rounding dust
        uint256 left = t.balanceOf(auction) + t.balanceOf(address(PM));
        assertEq(t.totalSupply(), left);
        assertLe(left, 2 * DUST);
        assertLe(pool, holders.length + 1 + PriceMath.payoutFor(12e6, left));
    }

    // ------------------------------------------------------------ v4 helpers

    function _swapExactOut(address who, uint256 shardsOut) internal {
        PoolKey memory k = _key();
        bool zeroForOne = !shardIs0; // USDC in
        vm.startPrank(who);
        USDC.approve(address(router), type(uint256).max);
        router.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(shardsOut),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function swapExactIn(address who, uint256 usdcIn) external {
        PoolKey memory k = _key();
        bool zeroForOne = !shardIs0;
        vm.startPrank(who);
        USDC.approve(address(router), type(uint256).max);
        router.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(usdcIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function daveLiquidity(int256 liq) external {
        _daveLiquidity(liq);
    }

    function _daveLiquidity(int256 liq) internal {
        PoolKey memory k = _key();
        vm.startPrank(dave);
        USDC.approve(address(lpRouter), type(uint256).max);
        ShardToken(shardToken).approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            k, IPoolManager.ModifyLiquidityParams({tickLower: -887200, tickUpper: 887200, liquidityDelta: liq, salt: 0}), ""
        );
        vm.stopPrank();
    }
}
