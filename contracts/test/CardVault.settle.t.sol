// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {ForkTest} from "./utils/ForkTest.sol";
import {CardVault} from "../src/CardVault.sol";
import {ShardToken} from "../src/ShardToken.sol";
import {ICCAAuction} from "../src/interfaces/ICCA.sol";
import {MockShardMarket} from "./mocks/MockShardMarket.sol";

contract CardVaultSettleTest is ForkTest {
    uint256 id;
    address shardToken;
    address auction;
    uint256 tick;
    uint256 bobBid;
    uint256 carolBid;

    /// The floor is a Q96 price rounded up from 10 USDC per shard, so fills round a few wei of shard units short of the
    /// exact USDC / 10 figure; that dust stays with the auction or is swept back to the owner.
    uint256 constant DUST = 100;

    function setUp() public override {
        super.setUp();
        id = _mintTo(alice);
    }

    /// Under-demand scenario: 8 shards for sale at a 10 USDC floor, bids worth 2.5 shards, so the clearing price stays at
    /// the floor, both bids fill completely and 5.5 shards are unsold.
    function _openAndBid(uint128 reserve) internal {
        CardVault.ShardParams memory p = _defaultParams();
        p.reserveUsdc = reserve;
        vm.prank(alice);
        (shardToken, auction) = vault.shardAndAuction(id, p);
        tick = ICCAAuction(auction).tickSpacing();
        bobBid = _bid(bob, auction, tick * 22, 10e6); // max 11 USDC per shard, budget 10 USDC
        carolBid = _bid(carol, auction, tick * 24, 15e6); // max 12 USDC per shard, budget 15 USDC
    }

    function test_settleGraduatedSeedsTheMarket() public {
        _openAndBid(0);
        vm.roll(ICCAAuction(auction).endBlock());
        ICCAAuction(auction).checkpoint(); // currencyRaised is only updated by a checkpoint

        uint256 grossRaised = ICCAAuction(auction).currencyRaised();
        assertEq(grossRaised, 25e6, "both bids fully committed");

        uint256 payoutBefore = USDC.balanceOf(payout);
        uint256 aliceBefore = USDC.balanceOf(alice);
        uint256 vaultBefore = USDC.balanceOf(address(vault));

        vm.prank(carol); // anyone may settle
        vault.settle(id);

        MockShardMarket.SeedCall memory call = market.lastSeed();
        uint256 fee = USDC.balanceOf(payout) - payoutBefore;
        uint256 raisedNet = fee + call.usdcAmount;
        assertLe(raisedNet, grossRaised, "protocol fee may be skimmed by the auction");
        assertGt(raisedNet, 0);
        assertEq(fee, raisedNet * 250 / 10_000, "vendor fee is 2.5 percent of net proceeds");
        assertEq(USDC.balanceOf(alice), aliceBefore, "owner receives no USDC");
        assertEq(USDC.balanceOf(address(vault)), vaultBefore, "vault keeps nothing from a sale");

        // the held half, the unsold shards and the proceeds after the fee all went to the market, then seed ran
        assertEq(market.seedCount(), 1);
        assertEq(call.cardId, id);
        assertEq(call.shardToken, shardToken);
        assertEq(call.clearingPriceQ96, ICCAAuction(auction).floorPrice(), "under-demand clears at the floor");
        assertEq(call.lpOwner, alice);
        assertApproxEqAbs(call.shardAmount, 135e17, DUST, "8 held + 5.5 unsold");
        assertEq(call.shardBalance, call.shardAmount, "shards transferred before seed");
        assertEq(call.usdcBalance, call.usdcAmount, "USDC transferred before seed");
        assertEq(ShardToken(shardToken).balanceOf(address(vault)), 0);
        assertEq(ShardToken(shardToken).balanceOf(alice), 0, "owner receives no shards");

        CardVault.Sharding memory s = vault.shardings(shardToken);
        assertTrue(s.settled);
        assertTrue(s.graduated);
        assertEq(s.clearingPriceQ96, call.clearingPriceQ96);

        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Sharded));

        (, string memory state,,, uint256 clearingUsdc) = names.lastState();
        assertEq(state, "sharded");
        assertEq(clearingUsdc, 10e6);
    }

    /// A zero-reserve auction with no bids still graduates: the market gets every shard and no USDC.
    function test_settleWithoutBidsSeedsShardsOnly() public {
        vm.prank(alice);
        (shardToken, auction) = vault.shardAndAuction(id, _defaultParams());
        vm.roll(ICCAAuction(auction).endBlock());
        vault.settle(id);

        assertTrue(vault.shardings(shardToken).graduated);
        MockShardMarket.SeedCall memory call = market.lastSeed();
        assertEq(market.seedCount(), 1);
        assertEq(call.shardAmount, 16e18);
        assertEq(call.usdcAmount, 0);
        assertEq(ShardToken(shardToken).balanceOf(address(market)), 16e18);
    }

    function test_biddersExitAndClaimAfterSettle() public {
        _openAndBid(0);
        vm.roll(ICCAAuction(auction).endBlock());
        vault.settle(id);

        ICCAAuction a = ICCAAuction(auction);
        vm.prank(bob);
        a.exitBid(bobBid);
        vm.prank(carol);
        a.exitBid(carolBid);
        a.claimTokens(bobBid); // anyone may claim for the bid owner
        a.claimTokens(carolBid);

        ShardToken t = ShardToken(shardToken);
        assertApproxEqAbs(t.balanceOf(bob), 1e18, DUST, "10 USDC at 10 per shard");
        assertLe(t.balanceOf(bob), 1e18, "fills never round in the bidder's favour");
        assertApproxEqAbs(t.balanceOf(carol), 15e17, DUST, "15 USDC at 10 per shard");
        assertLe(t.balanceOf(carol), 15e17, "fills never round in the bidder's favour");
        assertLe(t.balanceOf(auction), DUST, "auction drained up to rounding dust");
        assertEq(t.balanceOf(address(market)) + t.balanceOf(bob) + t.balanceOf(carol) + t.balanceOf(auction), 16e18, "supply conserved");
        assertEq(t.totalSupply(), 16e18);
    }

    function test_settleReserveMissedReturnsEverything() public {
        _openAndBid(1_000e6);
        vm.roll(ICCAAuction(auction).endBlock());

        uint256 payoutBefore = USDC.balanceOf(payout);
        uint256 aliceBefore = USDC.balanceOf(alice);
        vault.settle(id);

        assertEq(USDC.balanceOf(payout), payoutBefore, "no fee");
        assertEq(USDC.balanceOf(alice), aliceBefore, "no proceeds");
        assertEq(ShardToken(shardToken).balanceOf(alice), 16e18, "all shards back to owner");
        assertEq(market.seedCount(), 0, "no pool without graduation");
        assertEq(ShardToken(shardToken).balanceOf(address(market)), 0);
        CardVault.Sharding memory s = vault.shardings(shardToken);
        assertTrue(s.settled);
        assertFalse(s.graduated);
        assertEq(uint8(vault.cards(id).state), uint8(CardVault.State.Sharded));

        // bidders get full refunds and cannot claim tokens
        uint256 bobBefore = USDC.balanceOf(bob);
        vm.prank(bob);
        ICCAAuction(auction).exitBid(bobBid);
        assertEq(USDC.balanceOf(bob) - bobBefore, 10e6);
        vm.expectRevert();
        ICCAAuction(auction).claimTokens(bobBid);
    }

    function test_settleBeforeEndReverts() public {
        _openAndBid(0);
        vm.expectRevert(CardVault.AuctionNotOver.selector);
        vault.settle(id);
    }

    function test_settleTwiceReverts() public {
        _openAndBid(0);
        vm.roll(ICCAAuction(auction).endBlock());
        vault.settle(id);
        vm.expectRevert(abi.encodeWithSelector(CardVault.WrongState.selector, id, CardVault.State.Sharded));
        vault.settle(id);
    }

    function test_settleEmitsFee() public {
        _openAndBid(0);
        vm.roll(ICCAAuction(auction).endBlock());
        vm.recordLogs();
        vault.settle(id);
        // FeeAccrued(id, FeeKind.Sale, amount) must be present with kind == Sale
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FeeAccrued(uint256,uint8,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                (uint8 kind, uint256 amount) = abi.decode(logs[i].data, (uint8, uint256));
                assertEq(kind, uint8(CardVault.FeeKind.Sale));
                assertGt(amount, 0);
                found = true;
            }
        }
        assertTrue(found, "FeeAccrued emitted");
    }
}
