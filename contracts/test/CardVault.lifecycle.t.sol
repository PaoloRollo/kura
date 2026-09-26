// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkTest} from "./utils/ForkTest.sol";
import {CardVault} from "../src/CardVault.sol";
import {ShardToken} from "../src/ShardToken.sol";
import {Tickets} from "../src/libraries/Tickets.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {ICCAAuction} from "../src/interfaces/ICCA.sol";

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
