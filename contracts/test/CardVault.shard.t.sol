// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkTest} from "./utils/ForkTest.sol";
import {CardVault} from "../src/CardVault.sol";
import {ShardToken} from "../src/ShardToken.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {AuctionSteps} from "../src/libraries/AuctionSteps.sol";
import {ICCAAuction} from "../src/interfaces/ICCA.sol";
import {BidGateHook} from "../src/BidGateHook.sol";
import {ValidationHookLib} from "@cca/libraries/ValidationHookLib.sol";

contract CardVaultShardTest is ForkTest {
    uint256 id;

    function setUp() public override {
        super.setUp();
        id = _mintTo(alice);
    }

    function test_shardCreatesTokenAndAuction() public {
        CardVault.ShardParams memory p = _defaultParams();
        uint64 start = uint64(block.number);

        vm.prank(alice);
        (address shardToken, address auction) = vault.shardAndAuction(id, p);

        // NFT is escrowed, owner recorded
        assertEq(vault.ownerOf(id), address(vault));
        CardVault.Card memory c = vault.cards(id);
        assertEq(uint8(c.state), uint8(CardVault.State.Auctioning));
        assertEq(c.beneficialOwner, alice);
        assertEq(c.shardToken, shardToken);
        assertEq(c.auction, auction);
        assertEq(c.endBlock, start + 20);

        // shard supply split
        ShardToken token = ShardToken(shardToken);
        assertEq(token.totalSupply(), 16e18);
        assertEq(token.balanceOf(alice), 13e18);
        assertEq(token.balanceOf(auction), 3e18);
        assertEq(token.name(), "Shard black-lotus-lea-1");

        // auction wiring
        ICCAAuction a = ICCAAuction(auction);
        uint256 tickQ96 = PriceMath.usdcPerShardToQ96(500_000);
        assertEq(a.tickSpacing(), tickQ96);
        assertEq(a.floorPrice(), tickQ96 * 20);
        assertEq(a.floorPrice() % a.tickSpacing(), 0, "floor must sit on a tick");
        assertEq(a.startBlock(), start);
        assertEq(a.endBlock(), start + 20);
        assertEq(a.claimBlock(), start + 20);
        assertEq(a.totalSupply(), 3e18);
        assertEq(a.validationHook(), address(hook));
        assertEq(a.fundsRecipient(), address(vault));
        assertEq(a.tokensRecipient(), address(vault));
        assertEq(a.currency(), address(USDC));
        assertEq(a.token(), shardToken);

        // sharding record and ENS state
        CardVault.Sharding memory s = vault.shardings(shardToken);
        assertEq(s.cardId, id);
        assertEq(s.totalShards, 16);
        assertEq(s.forSale, 3);
        assertFalse(s.settled);
        (, string memory state, address stToken, address stAuction,) = names.lastState();
        assertEq(state, "auctioning");
        assertEq(stToken, shardToken);
        assertEq(stAuction, auction);
    }

    function test_onlyCardOwnerCanShard() public {
        vm.prank(bob);
        vm.expectRevert(CardVault.NotCardOwner.selector);
        vault.shardAndAuction(id, _defaultParams());
    }

    function test_cannotShardTwice() public {
        vm.startPrank(alice);
        vault.shardAndAuction(id, _defaultParams());
        vm.expectRevert(abi.encodeWithSelector(CardVault.WrongState.selector, id, CardVault.State.Auctioning));
        vault.shardAndAuction(id, _defaultParams());
        vm.stopPrank();
    }

    function test_rejectsInvalidParams() public {
        CardVault.ShardParams memory p = _defaultParams();
        vm.startPrank(alice);

        p.totalShards = 15;
        vm.expectRevert(CardVault.InvalidShardCount.selector);
        vault.shardAndAuction(id, p);
        p.totalShards = 528;
        vm.expectRevert(CardVault.InvalidShardCount.selector);
        vault.shardAndAuction(id, p);
        p.totalShards = 17;
        vm.expectRevert(CardVault.InvalidShardCount.selector);
        vault.shardAndAuction(id, p);

        p = _defaultParams();
        p.forSale = 0;
        vm.expectRevert(CardVault.InvalidForSale.selector);
        vault.shardAndAuction(id, p);
        p.forSale = 17;
        vm.expectRevert(CardVault.InvalidForSale.selector);
        vault.shardAndAuction(id, p);

        p = _defaultParams();
        p.tickUsdcPerShard = 0;
        vm.expectRevert(CardVault.InvalidPricing.selector);
        vault.shardAndAuction(id, p);
        p.tickUsdcPerShard = 3_000_000; // 10 is not a multiple of 3
        vm.expectRevert(CardVault.InvalidPricing.selector);
        vault.shardAndAuction(id, p);
        p.tickUsdcPerShard = 20_000_000; // tick above floor
        vm.expectRevert(CardVault.InvalidPricing.selector);
        vault.shardAndAuction(id, p);

        p = _defaultParams();
        p.durationBlocks = 1;
        vm.expectRevert(AuctionSteps.DurationOutOfRange.selector);
        vault.shardAndAuction(id, p);
        vm.stopPrank();
    }

    function test_sellEverythingAndKeepNothing() public {
        CardVault.ShardParams memory p = _defaultParams();
        p.forSale = 16;
        vm.prank(alice);
        (address shardToken, address auction) = vault.shardAndAuction(id, p);
        assertEq(ShardToken(shardToken).balanceOf(alice), 0);
        assertEq(ShardToken(shardToken).balanceOf(auction), 16e18);
    }

    function test_bidWithoutTicketReverts() public {
        vm.prank(alice);
        (, address auction) = vault.shardAndAuction(id, _defaultParams());
        _dealUsdc(bob, 20e6);
        _permitAuction(bob, auction, 20e6);
        uint256 tick = ICCAAuction(auction).tickSpacing();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ValidationHookLib.ValidationHookCallFailed.selector, bytes("")));
        ICCAAuction(auction).submitBid(tick * 22, 20e6, bob, "");
    }

    function test_bidWithWrongSubjectTicketReverts() public {
        vm.prank(alice);
        (, address auction) = vault.shardAndAuction(id, _defaultParams());
        bytes memory data = _humanTicket(alice, 1);
        _dealUsdc(bob, 20e6);
        _permitAuction(bob, auction, 20e6);
        uint256 tick = ICCAAuction(auction).tickSpacing();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                ValidationHookLib.ValidationHookCallFailed.selector, abi.encodeWithSelector(BidGateHook.WrongSubject.selector)
            )
        );
        ICCAAuction(auction).submitBid(tick * 22, 20e6, bob, data);
    }

    function test_bidWithTicketSucceeds() public {
        vm.prank(alice);
        (, address auction) = vault.shardAndAuction(id, _defaultParams());
        uint256 tick = ICCAAuction(auction).tickSpacing();
        uint256 bidId = _bid(bob, auction, tick * 22, 20e6);
        assertEq(ICCAAuction(auction).bids(bidId).owner, bob);
        assertEq(USDC.balanceOf(bob), 0);
        assertEq(hook.nullifierOwner(uint256(uint160(bob))), bob);
    }
}
