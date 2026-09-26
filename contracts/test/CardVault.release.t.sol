// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CardVault} from "../src/CardVault.sol";
import {Tickets} from "../src/libraries/Tickets.sol";
import {TicketVerifier} from "../src/TicketVerifier.sol";
import {MockCardNames} from "./utils/MockCardNames.sol";

contract CardVaultReleaseTest is Test {
    uint256 signerPk = 0xA11CE;
    address signer;
    address owner = makeAddr("owner");
    address vendor = makeAddr("vendor");
    address payout = makeAddr("payout");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    MockCardNames names;
    CardVault vault;
    uint256 id;

    function setUp() public {
        signer = vm.addr(signerPk);
        names = new MockCardNames();
        vault = new CardVault(
            CardVault.Config({
                owner: owner,
                vendor: vendor,
                feeBps: 250,
                payout: payout,
                signer: signer,
                usdc: makeAddr("usdc"),
                ccaFactory: makeAddr("factory"),
                hook: makeAddr("hook"),
                names: address(names),
                baseURI: "https://kura.example/api/meta/",
                siteURI: "https://kura.example/app/cards/"
            })
        );
        vm.warp(1_700_000_000);
        vm.prank(vendor);
        id = vault.mint(
            CardVault.MintInput({
                to: alice,
                scryfallId: "bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd",
                slug: "black-lotus",
                setCode: "lea",
                condition: "NM",
                language: "en",
                imageUrl: "https://cards.scryfall.io/normal/front/b/d/bd8fa327.jpg",
                description: "Black Lotus, Limited Edition Alpha"
            })
        );
    }

    function _ticket(address subject, uint8 kind, uint256 nullifier) internal view returns (Tickets.Ticket memory t, bytes memory sig) {
        t = Tickets.Ticket({kind: kind, subject: subject, nullifier: nullifier, expiresAt: block.timestamp + 15 minutes});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, vault.ticketDigest(t));
        sig = abi.encodePacked(r, s, v);
    }

    function test_vendorReleasesWithPassportTicket() public {
        (Tickets.Ticket memory t, bytes memory sig) = _ticket(alice, Tickets.KIND_PASSPORT, 99);
        vm.prank(vendor);
        vm.expectEmit(true, true, true, true);
        emit CardVault.CardReleased(id, alice);
        vault.confirmRelease(id, t, sig);

        assertEq(uint8(vault.cards(id).state), uint8(CardVault.State.Released));
        assertTrue(names.revoked(id));
        assertTrue(vault.usedTickets(vault.ticketDigest(t)));
        assertEq(vault.ownerOf(id), alice, "NFT stays with the holder as a record");
    }

    function test_nonVendorCannotRelease() public {
        (Tickets.Ticket memory t, bytes memory sig) = _ticket(alice, Tickets.KIND_PASSPORT, 99);
        vm.prank(alice);
        vm.expectRevert(CardVault.OnlyVendor.selector);
        vault.confirmRelease(id, t, sig);
    }

    function test_humanTicketNotEnough() public {
        (Tickets.Ticket memory t, bytes memory sig) = _ticket(alice, Tickets.KIND_HUMAN, 99);
        vm.prank(vendor);
        vm.expectRevert(CardVault.WrongTicketKind.selector);
        vault.confirmRelease(id, t, sig);
    }

    function test_ticketMustNameTheHolder() public {
        (Tickets.Ticket memory t, bytes memory sig) = _ticket(bob, Tickets.KIND_PASSPORT, 99);
        vm.prank(vendor);
        vm.expectRevert(CardVault.TicketSubjectMismatch.selector);
        vault.confirmRelease(id, t, sig);
    }

    function test_ticketIsSingleUse() public {
        // alice owns two cards; one passport ticket must not release both
        vm.prank(vendor);
        uint256 id2 = vault.mint(
            CardVault.MintInput({
                to: alice,
                scryfallId: "x",
                slug: "mox-pearl",
                setCode: "lea",
                condition: "LP",
                language: "en",
                imageUrl: "",
                description: ""
            })
        );
        (Tickets.Ticket memory t, bytes memory sig) = _ticket(alice, Tickets.KIND_PASSPORT, 99);
        vm.startPrank(vendor);
        vault.confirmRelease(id, t, sig);
        vm.expectRevert(CardVault.TicketUsed.selector);
        vault.confirmRelease(id2, t, sig);
        vm.stopPrank();
        assertEq(uint8(vault.cards(id2).state), uint8(CardVault.State.Whole));
    }

    function test_expiredOrForgedRejected() public {
        (Tickets.Ticket memory t, bytes memory sig) = _ticket(alice, Tickets.KIND_PASSPORT, 99);
        vm.warp(t.expiresAt + 1);
        vm.prank(vendor);
        vm.expectRevert(TicketVerifier.Expired.selector);
        vault.confirmRelease(id, t, sig);

        vm.warp(t.expiresAt - 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, vault.ticketDigest(t));
        vm.prank(vendor);
        vm.expectRevert(TicketVerifier.BadSignature.selector);
        vault.confirmRelease(id, t, abi.encodePacked(r, s, v));
    }

    function test_releasedCardIsTerminal() public {
        (Tickets.Ticket memory t, bytes memory sig) = _ticket(alice, Tickets.KIND_PASSPORT, 99);
        vm.prank(vendor);
        vault.confirmRelease(id, t, sig);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardVault.WrongState.selector, id, CardVault.State.Released));
        vault.shardAndAuction(
            id,
            CardVault.ShardParams({
                totalShards: 16, floorUsdcPerShard: 1e6, tickUsdcPerShard: 1e6, reserveUsdc: 0, durationBlocks: 2
            })
        );

        // a released card can still change hands as a record, without touching ENS
        vm.prank(alice);
        vault.transferFrom(alice, bob, id);
        assertEq(vault.ownerOf(id), bob);
        assertEq(names.ownerRecords(id), alice, "no ENS write after the name was revoked");
    }
}
