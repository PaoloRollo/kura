// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IValidationHook} from "@cca/interfaces/IValidationHook.sol";
import {Tickets} from "../src/libraries/Tickets.sol";
import {TicketVerifier} from "../src/TicketVerifier.sol";
import {BidGateHook} from "../src/BidGateHook.sol";

contract BidGateHookTest is Test {
    uint256 signerPk = 0xA11CE;
    address signer;
    address owner = makeAddr("owner");
    address auction = makeAddr("auction");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    BidGateHook hook;

    function setUp() public {
        signer = vm.addr(signerPk);
        hook = new BidGateHook(signer, owner);
        vm.warp(1_700_000_000);
    }

    function _ticketFor(address subject, uint256 nullifier, uint8 kind) internal view returns (Tickets.Ticket memory) {
        return Tickets.Ticket({kind: kind, subject: subject, nullifier: nullifier, expiresAt: block.timestamp + 1 days});
    }

    function _hookData(Tickets.Ticket memory t, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hook.ticketDigest(t));
        return abi.encode(t, abi.encodePacked(r, s, v));
    }

    function _validateAs(address bidder, bytes memory data) internal {
        vm.prank(auction);
        hook.validate(1e18, 100e6, bidder, bidder, data);
    }

    function test_validTicketBindsNullifier() public {
        Tickets.Ticket memory t = _ticketFor(alice, 7, Tickets.KIND_HUMAN);
        vm.expectEmit(true, true, true, true);
        emit BidGateHook.BidderBound(7, alice);
        _validateAs(alice, _hookData(t, signerPk));
        assertEq(hook.nullifierOwner(7), alice);
    }

    function test_sameWalletCanBidAgainWithSameTicket() public {
        Tickets.Ticket memory t = _ticketFor(alice, 7, Tickets.KIND_HUMAN);
        bytes memory data = _hookData(t, signerPk);
        _validateAs(alice, data);
        _validateAs(alice, data);
        assertEq(hook.nullifierOwner(7), alice);
    }

    function test_sameHumanDifferentWalletRejected() public {
        _validateAs(alice, _hookData(_ticketFor(alice, 7, Tickets.KIND_HUMAN), signerPk));
        bytes memory bobData = _hookData(_ticketFor(bob, 7, Tickets.KIND_HUMAN), signerPk);
        vm.prank(auction);
        vm.expectRevert(abi.encodeWithSelector(BidGateHook.AlreadyBound.selector, alice));
        hook.validate(1e18, 100e6, bob, bob, bobData);
    }

    function test_ticketForAnotherWalletRejected() public {
        bytes memory data = _hookData(_ticketFor(alice, 7, Tickets.KIND_HUMAN), signerPk);
        vm.prank(auction);
        vm.expectRevert(BidGateHook.WrongSubject.selector);
        hook.validate(1e18, 100e6, bob, bob, data);
    }

    function test_bidOwnerMustEqualSender() public {
        bytes memory data = _hookData(_ticketFor(alice, 7, Tickets.KIND_HUMAN), signerPk);
        vm.prank(auction);
        vm.expectRevert(BidGateHook.WrongSubject.selector);
        hook.validate(1e18, 100e6, bob, alice, data);
    }

    function test_passportKindRejected() public {
        bytes memory data = _hookData(_ticketFor(alice, 7, Tickets.KIND_PASSPORT), signerPk);
        vm.prank(auction);
        vm.expectRevert(BidGateHook.WrongKind.selector);
        hook.validate(1e18, 100e6, alice, alice, data);
    }

    function test_expiredRejected() public {
        Tickets.Ticket memory t = _ticketFor(alice, 7, Tickets.KIND_HUMAN);
        bytes memory data = _hookData(t, signerPk);
        vm.warp(t.expiresAt + 1);
        vm.prank(auction);
        vm.expectRevert(TicketVerifier.Expired.selector);
        hook.validate(1e18, 100e6, alice, alice, data);
    }

    function test_forgedSignatureRejected() public {
        bytes memory data = _hookData(_ticketFor(alice, 7, Tickets.KIND_HUMAN), 0xBAD);
        vm.prank(auction);
        vm.expectRevert(TicketVerifier.BadSignature.selector);
        hook.validate(1e18, 100e6, alice, alice, data);
    }

    function test_onlyOwnerRotatesSigner() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.setSigner(alice);
        vm.prank(owner);
        hook.setSigner(alice);
        assertEq(hook.signer(), alice);
    }

    function test_erc165() public view {
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
        assertTrue(hook.supportsInterface(type(IValidationHook).interfaceId));
        assertEq(type(IValidationHook).interfaceId, bytes4(0x22c44b5f));
        assertFalse(hook.supportsInterface(0xffffffff));
    }
}
