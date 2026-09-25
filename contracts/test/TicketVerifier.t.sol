// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Tickets} from "../src/libraries/Tickets.sol";
import {TicketVerifier} from "../src/TicketVerifier.sol";

contract VerifierHarness is TicketVerifier {
    constructor(address signer_) TicketVerifier("Kura Test", signer_) {}

    function verifyTicket(Tickets.Ticket memory t, bytes memory sig) external view {
        _verifyTicket(t, sig);
    }

    function verifyAppraisal(Tickets.Appraisal memory a, bytes memory sig) external view {
        _verifyAppraisal(a, sig);
    }

    function setSigner(address s) external {
        _setSigner(s);
    }
}

contract TicketVerifierTest is Test {
    uint256 signerPk = 0xA11CE;
    address signer;
    uint256 attackerPk = 0xBAD;
    VerifierHarness verifier;

    function setUp() public {
        signer = vm.addr(signerPk);
        verifier = new VerifierHarness(signer);
        vm.warp(1_700_000_000);
    }

    function _ticket() internal returns (Tickets.Ticket memory) {
        return Tickets.Ticket({
            kind: Tickets.KIND_HUMAN, subject: makeAddr("alice"), nullifier: 42, expiresAt: block.timestamp + 1 days
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_validTicketPasses() public {
        Tickets.Ticket memory t = _ticket();
        verifier.verifyTicket(t, _sign(signerPk, verifier.ticketDigest(t)));
    }

    function test_wrongSignerRejected() public {
        Tickets.Ticket memory t = _ticket();
        bytes memory sig = _sign(attackerPk, verifier.ticketDigest(t));
        vm.expectRevert(TicketVerifier.BadSignature.selector);
        verifier.verifyTicket(t, sig);
    }

    function test_tamperedFieldRejected() public {
        Tickets.Ticket memory t = _ticket();
        bytes memory sig = _sign(signerPk, verifier.ticketDigest(t));
        t.subject = makeAddr("mallory");
        vm.expectRevert(TicketVerifier.BadSignature.selector);
        verifier.verifyTicket(t, sig);
    }

    function test_expiredTicketRejected() public {
        Tickets.Ticket memory t = _ticket();
        bytes memory sig = _sign(signerPk, verifier.ticketDigest(t));
        vm.warp(t.expiresAt + 1);
        vm.expectRevert(TicketVerifier.Expired.selector);
        verifier.verifyTicket(t, sig);
    }

    function test_appraisalRoundTrip() public {
        Tickets.Appraisal memory a = Tickets.Appraisal({
            cardId: 1, shardToken: makeAddr("shard"), usdcPerShard: 12_500_000, expiresAt: block.timestamp + 10 minutes
        });
        verifier.verifyAppraisal(a, _sign(signerPk, verifier.appraisalDigest(a)));
        a.usdcPerShard = 1;
        bytes memory sig = _sign(signerPk, verifier.appraisalDigest(a));
        a.usdcPerShard = 2;
        vm.expectRevert(TicketVerifier.BadSignature.selector);
        verifier.verifyAppraisal(a, sig);
    }

    function test_signerRotation() public {
        Tickets.Ticket memory t = _ticket();
        bytes memory oldSig = _sign(signerPk, verifier.ticketDigest(t));
        address newSigner = vm.addr(attackerPk);
        vm.expectEmit(true, true, true, true);
        emit TicketVerifier.SignerUpdated(newSigner);
        verifier.setSigner(newSigner);
        vm.expectRevert(TicketVerifier.BadSignature.selector);
        verifier.verifyTicket(t, oldSig);
        verifier.verifyTicket(t, _sign(attackerPk, verifier.ticketDigest(t)));
    }

    function test_typeStringsMatchBackendContract() public pure {
        assertEq(
            Tickets.TICKET_TYPEHASH, keccak256("Ticket(uint8 kind,address subject,uint256 nullifier,uint256 expiresAt)")
        );
        assertEq(
            Tickets.APPRAISAL_TYPEHASH,
            keccak256("Appraisal(uint256 cardId,address shardToken,uint256 usdcPerShard,uint256 expiresAt)")
        );
    }
}
