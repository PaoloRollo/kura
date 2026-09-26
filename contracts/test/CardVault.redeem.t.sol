// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkTest} from "./utils/ForkTest.sol";
import {CardVault} from "../src/CardVault.sol";
import {ShardToken} from "../src/ShardToken.sol";
import {Tickets} from "../src/libraries/Tickets.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {TicketVerifier} from "../src/TicketVerifier.sol";
import {ICCAAuction} from "../src/interfaces/ICCA.sol";

contract CardVaultRedeemTest is ForkTest {
    uint256 id;
    address shardToken;
    address auction;

    /// The CCA floor is a Q96 price rounded up, so fills land a few wei of shard units short of the exact figures and a
    /// couple of wei stay in the auction forever. Expected amounts are derived from on-chain balances; shard balances
    /// are compared against the round figures within this tolerance.
    uint256 constant DUST = 100;

    /// After this: alice ~13.5 shards (bought from the pool), bob ~1, carol ~1.5 (all within DUST), clearing 10 USDC per
    /// shard, card Sharded.
    function setUp() public override {
        super.setUp();
        id = _mintTo(alice);
        (shardToken, auction) = _runAuction(id, _defaultParams(), true);
    }

    function _runAuction(uint256 cardId, CardVault.ShardParams memory p, bool withBids) internal returns (address t, address a) {
        vm.prank(alice);
        (t, a) = vault.shardAndAuction(cardId, p);
        uint256 bobBid;
        uint256 carolBid;
        if (withBids) {
            uint256 tick = ICCAAuction(a).tickSpacing();
            bobBid = _bid(bob, a, tick * 22, 10e6);
            carolBid = _bid(carol, a, tick * 24, 15e6);
        }
        vm.roll(ICCAAuction(a).endBlock());
        vault.settle(cardId);
        _buyPool(t, alice); // alice buys every shard the settle put in the pool
        if (withBids) {
            vm.prank(bob);
            ICCAAuction(a).exitBid(bobBid);
            vm.prank(carol);
            ICCAAuction(a).exitBid(carolBid);
            ICCAAuction(a).claimTokens(bobBid);
            ICCAAuction(a).claimTokens(carolBid);
        }
    }

    function _fundAndApprove(address who, uint256 amount) internal {
        _dealUsdc(who, amount);
        vm.prank(who);
        USDC.approve(address(vault), amount);
    }

    /// @dev USDC alice owes to buy out everyone else in `token` at `price`: (payout, fee).
    function _owed(address token, address redeemer, uint256 price) internal view returns (uint256 p, uint256 fee) {
        uint256 missing = ShardToken(token).totalSupply() - ShardToken(token).balanceOf(redeemer);
        p = PriceMath.payoutFor(price, missing);
        fee = p * 250 / 10_000;
    }

    function test_redeemAtAppraisalAboveClearing() public {
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 12e6);
        // missing ~2.5 shards at 12 USDC ~= 30 USDC, fee 2.5 percent on top ~= 0.75 USDC
        (uint256 expectedPayout, uint256 expectedFee) = _owed(shardToken, alice, 12e6);
        assertApproxEqAbs(expectedPayout, 30e6, 1);
        _fundAndApprove(alice, expectedPayout + expectedFee);
        uint256 payoutBefore = USDC.balanceOf(payout);
        uint256 aliceUsdcBefore = USDC.balanceOf(alice); // includes her sale proceeds from settle
        uint256 vaultUsdcBefore = USDC.balanceOf(address(vault));
        uint256 minority = ShardToken(shardToken).totalSupply() - ShardToken(shardToken).balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit CardVault.CardRedeemed(id, shardToken, alice, 12e6, expectedPayout, expectedFee);
        vault.redeem(id, a, sig);

        assertEq(vault.ownerOf(id), alice);
        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Whole));
        assertEq(c.shardToken, address(0));
        assertEq(c.beneficialOwner, alice);
        assertEq(ShardToken(shardToken).balanceOf(alice), 0, "redeemer's shards burned");
        assertEq(ShardToken(shardToken).totalSupply(), minority, "only minority shards remain");
        assertApproxEqAbs(ShardToken(shardToken).totalSupply(), 25e17, DUST);
        assertEq(USDC.balanceOf(payout) - payoutBefore, expectedFee);
        assertEq(USDC.balanceOf(address(vault)) - vaultUsdcBefore, expectedPayout, "payout pool held for minority");
        assertEq(aliceUsdcBefore - USDC.balanceOf(alice), expectedPayout + expectedFee, "redeemer pays payout plus fee");

        CardVault.Sharding memory s = vault.shardings(shardToken);
        assertEq(s.buyoutPerShard, 12e6);
        assertEq(s.payoutPool, expectedPayout);
        assertEq(s.redeemer, alice);
        assertEq(names.ownerRecords(id), alice);
        (, string memory state,,, uint256 clearing) = names.lastState();
        assertEq(state, "whole");
        assertEq(clearing, 12e6);
    }

    function test_appraisalBelowClearingFloorsToClearing() public {
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 8e6);
        (uint256 expectedPayout, uint256 expectedFee) = _owed(shardToken, alice, 10e6); // ~2.5 * 10 = 25, fee ~0.625
        assertApproxEqAbs(expectedPayout, 25e6, 1);
        _fundAndApprove(alice, expectedPayout + expectedFee);
        vm.prank(alice);
        vault.redeem(id, a, sig);
        assertEq(vault.shardings(shardToken).buyoutPerShard, 10e6);
        assertEq(vault.shardings(shardToken).payoutPool, expectedPayout);
    }

    function test_belowThresholdReverts() public {
        vm.prank(alice);
        ShardToken(shardToken).transfer(bob, 1e18); // alice ~12.5 / 16 = 78.1 percent
        uint256 bal = ShardToken(shardToken).balanceOf(alice);
        assertApproxEqAbs(bal, 125e17, DUST);
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 12e6);
        _fundAndApprove(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardVault.BelowThreshold.selector, bal, 16e18));
        vault.redeem(id, a, sig);
    }

    function test_thresholdBoundaryOn32Shards() public {
        uint256 id2 = _mintTo(alice);
        CardVault.ShardParams memory p = _defaultParams();
        p.totalShards = 32;
        (address t2,) = _runAuction(id2, p, false); // no bids: all 32 shards end with alice
        assertEq(ShardToken(t2).balanceOf(alice), 32e18);

        vm.prank(alice);
        ShardToken(t2).transfer(bob, 7e18); // alice 25 / 32 = 78.1 percent
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id2, t2, 1e6);
        _fundAndApprove(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardVault.BelowThreshold.selector, 25e18, 32e18));
        vault.redeem(id2, a, sig);

        vm.prank(bob);
        ShardToken(t2).transfer(alice, 1e18); // alice 26 / 32 = 81.25 percent
        vm.prank(alice);
        vault.redeem(id2, a, sig);
        assertEq(vault.ownerOf(id2), alice);
    }

    function test_appraisalForPreviousShardingRejected() public {
        // first redeem, then shard again and sell one shard to bob
        (Tickets.Appraisal memory a1, bytes memory sig1) = _appraisal(id, shardToken, 12e6);
        (uint256 p1, uint256 f1) = _owed(shardToken, alice, 12e6);
        _fundAndApprove(alice, p1 + f1);
        vm.prank(alice);
        vault.redeem(id, a1, sig1);

        vm.prank(alice);
        (address token2, address auction2) = vault.shardAndAuction(id, _defaultParams());
        uint256 tick = ICCAAuction(auction2).tickSpacing();
        uint256 bobBid2 = _bid(bob, auction2, tick * 22, 10e6);
        vm.roll(ICCAAuction(auction2).endBlock());
        vault.settle(id);
        _buyPool(token2, alice);
        vm.prank(bob);
        ICCAAuction(auction2).exitBid(bobBid2);
        ICCAAuction(auction2).claimTokens(bobBid2);
        assertApproxEqAbs(ShardToken(token2).balanceOf(alice), 15e18, DUST);

        (Tickets.Appraisal memory stale, bytes memory staleSig) = _appraisal(id, shardToken, 1e6); // old token, cheap price
        _fundAndApprove(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(CardVault.AppraisalMismatch.selector);
        vault.redeem(id, stale, staleSig);

        (Tickets.Appraisal memory fresh, bytes memory freshSig) = _appraisal(id, token2, 12e6);
        vm.prank(alice);
        vault.redeem(id, fresh, freshSig);
        assertEq(vault.shardings(token2).buyoutPerShard, 12e6);
    }

    function test_expiredOrWrongCardAppraisalRejected() public {
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 12e6);
        _fundAndApprove(alice, 100e6);
        vm.warp(a.expiresAt + 1);
        vm.prank(alice);
        vm.expectRevert(TicketVerifier.Expired.selector);
        vault.redeem(id, a, sig);

        (Tickets.Appraisal memory b, bytes memory sigB) = _appraisal(id + 1, shardToken, 12e6);
        vm.prank(alice);
        vm.expectRevert(CardVault.AppraisalMismatch.selector);
        vault.redeem(id, b, sigB);
    }

    function test_appraisalFromWrongSignerRejected() public {
        Tickets.Appraisal memory a =
            Tickets.Appraisal({cardId: id, shardToken: shardToken, usdcPerShard: 12e6, expiresAt: block.timestamp + 10 minutes});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, vault.appraisalDigest(a));
        _fundAndApprove(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(TicketVerifier.BadSignature.selector);
        vault.redeem(id, a, abi.encodePacked(r, s, v));
    }

    function test_redeemRequiresShardedState() public {
        uint256 id2 = _mintTo(alice);
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id2, address(0), 12e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardVault.WrongState.selector, id2, CardVault.State.Whole));
        vault.redeem(id2, a, sig);
    }

    function test_minorityClaimsPayout() public {
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 12e6);
        (uint256 pool, uint256 fee) = _owed(shardToken, alice, 12e6);
        _fundAndApprove(alice, pool + fee);
        vm.prank(alice);
        vault.redeem(id, a, sig);

        ShardToken t = ShardToken(shardToken);
        uint256 bobShards = t.balanceOf(bob);
        uint256 bobOwed = PriceMath.payoutFor(12e6, bobShards);
        assertApproxEqAbs(bobShards, 1e18, DUST);
        uint256 bobUsdcBefore = USDC.balanceOf(bob);
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit CardVault.PayoutClaimed(id, shardToken, bob, bobShards, bobOwed);
        vault.claimPayout(shardToken);
        assertEq(USDC.balanceOf(bob) - bobUsdcBefore, bobOwed);
        assertApproxEqAbs(bobOwed, 12e6, 1);
        assertEq(t.balanceOf(bob), 0, "claimant's shards burned");

        uint256 carolShards = t.balanceOf(carol);
        uint256 carolOwed = PriceMath.payoutFor(12e6, carolShards);
        assertApproxEqAbs(carolShards, 15e17, DUST);
        uint256 carolUsdcBefore = USDC.balanceOf(carol);
        vm.prank(carol);
        vault.claimPayout(shardToken);
        assertEq(USDC.balanceOf(carol) - carolUsdcBefore, carolOwed);
        assertApproxEqAbs(carolOwed, 18e6, 1);

        // only the shards still sitting in the auction remain, and their payout is still reserved
        assertEq(vault.shardings(shardToken).payoutPool, pool - bobOwed - carolOwed);
        assertLe(vault.shardings(shardToken).payoutPool, PriceMath.payoutFor(12e6, t.totalSupply()) + 2);
        assertEq(t.totalSupply(), t.balanceOf(auction));
        assertLe(t.totalSupply(), DUST);

        vm.prank(bob);
        vm.expectRevert(CardVault.NothingToClaim.selector);
        vault.claimPayout(shardToken);
    }

    function test_claimOnUnredeemedTokenReverts() public {
        vm.prank(bob);
        vm.expectRevert(CardVault.NotRedeemed.selector);
        vault.claimPayout(shardToken);
    }

    function test_fullHolderRedeemsWithoutAppraisal() public {
        uint256 id2 = _mintTo(alice);
        CardVault.ShardParams memory p = _defaultParams();
        p.reserveUsdc = 1_000e6; // reserve will be missed, everything returns to alice
        (address t2,) = _runAuction(id2, p, false);
        assertEq(ShardToken(t2).balanceOf(alice), 16e18);

        uint256 aliceUsdcBefore = USDC.balanceOf(alice);
        uint256 payoutBefore = USDC.balanceOf(payout);
        Tickets.Appraisal memory none;
        vm.prank(alice);
        vault.redeem(id2, none, "");
        assertEq(vault.ownerOf(id2), alice);
        assertEq(uint8(vault.cards(id2).state), uint8(CardVault.State.Whole));
        assertEq(ShardToken(t2).totalSupply(), 0);
        assertEq(USDC.balanceOf(alice), aliceUsdcBefore, "full holder pays nothing");
        assertEq(USDC.balanceOf(payout), payoutBefore, "no fee");
    }

    /// Fractional balances spread over several holders never make the payout pool underflow, and every holder
    /// receives exactly floor(balance * price / 1e18).
    function testFuzz_fractionalClaimsNeverUnderflow(uint256 seed) public {
        address[5] memory holders = [makeAddr("h0"), makeAddr("h1"), makeAddr("h2"), makeAddr("h3"), makeAddr("h4")];
        ShardToken t = ShardToken(shardToken);
        // bob (~1e18) and carol (~1.5e18) split their shards into pseudo-random fractions
        uint256 bobLeft = t.balanceOf(bob);
        uint256 carolLeft = t.balanceOf(carol);
        for (uint256 i = 0; i < 5; i++) {
            uint256 fromBob = uint256(keccak256(abi.encode(seed, i, "b"))) % (bobLeft + 1);
            uint256 fromCarol = uint256(keccak256(abi.encode(seed, i, "c"))) % (carolLeft + 1);
            if (fromBob > 0) {
                vm.prank(bob);
                t.transfer(holders[i], fromBob);
                bobLeft -= fromBob;
            }
            if (fromCarol > 0) {
                vm.prank(carol);
                t.transfer(holders[i], fromCarol);
                carolLeft -= fromCarol;
            }
        }

        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 12e6);
        (uint256 initialPool, uint256 fee) = _owed(shardToken, alice, 12e6);
        _fundAndApprove(alice, initialPool + fee);
        vm.prank(alice);
        vault.redeem(id, a, sig);
        assertEq(vault.shardings(shardToken).payoutPool, initialPool);

        address[7] memory claimants = [holders[0], holders[1], holders[2], holders[3], holders[4], bob, carol];
        uint256 claimed;
        for (uint256 i = 0; i < 7; i++) {
            uint256 bal = t.balanceOf(claimants[i]);
            if (bal == 0) continue;
            uint256 expected = bal * 12e6 / 1e18;
            uint256 before = USDC.balanceOf(claimants[i]);
            vm.prank(claimants[i]);
            vault.claimPayout(shardToken);
            assertEq(USDC.balanceOf(claimants[i]) - before, expected);
            claimed += expected;
        }
        uint256 remainingSupply = t.totalSupply();
        assertEq(remainingSupply, t.balanceOf(auction), "only auction dust left unclaimed");
        assertLe(remainingSupply, DUST);
        uint256 pool = vault.shardings(shardToken).payoutPool;
        assertEq(pool, initialPool - claimed, "pool accounting identity");
        // floor loss: at most 1 unit per claimant (7) plus 1 for splitting the auction dust off the floored pool,
        // plus the dust's own (floored) share, which is reserved for a future claim by the auction's bidders
        assertLe(pool, 7 + 1 + PriceMath.payoutFor(12e6, remainingSupply), "dust bounded by number of claimants");
    }

    /// The market is unwound during redeem, after the card is Whole again and before the redeemer's shards burn. Shards
    /// still in the pool go to the LP owner, who claims them like any other minority holder.
    function test_redeemUnwindsTheMarket() public {
        uint256 id2 = _mintTo(alice);
        vm.prank(alice);
        (address t2, address a2) = vault.shardAndAuction(id2, _defaultParams());
        vm.roll(ICCAAuction(a2).endBlock());
        vault.settle(id2); // no bids: all 16 shards seed the pool
        market.give(t2, bob, 13e18); // bob buys 13 of them: 81.25 percent

        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id2, t2, 12e6);
        (uint256 pool, uint256 fee) = _owed(t2, bob, 12e6);
        _fundAndApprove(bob, pool + fee);
        vm.prank(bob);
        vault.redeem(id2, a, sig);

        assertEq(market.unwindCount(), 1);
        assertEq(market.lastUnwound(), id2);
        assertEq(uint8(market.stateAtUnwind()), uint8(CardVault.State.Whole), "state written before unwind");
        assertEq(market.redeemerBalanceAtUnwind(), 13e18, "unwind runs before the burn");
        assertEq(ShardToken(t2).balanceOf(alice), 3e18, "pool shards returned to the LP owner");

        uint256 before = USDC.balanceOf(alice);
        vm.prank(alice);
        vault.claimPayout(t2);
        assertEq(USDC.balanceOf(alice) - before, 36e6);
        assertEq(vault.shardings(t2).payoutPool, 0);
    }

    function test_redeemWithoutPoolStillCallsUnwind() public {
        uint256 id2 = _mintTo(alice);
        CardVault.ShardParams memory p = _defaultParams();
        p.reserveUsdc = 1_000e6; // not graduated: no seed
        _runAuction(id2, p, false);
        Tickets.Appraisal memory none;
        vm.prank(alice);
        vault.redeem(id2, none, "");
        assertEq(market.lastUnwound(), id2);
    }
}
