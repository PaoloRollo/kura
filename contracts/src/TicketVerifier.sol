// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Tickets} from "./libraries/Tickets.sol";

/// @notice Shared EIP-712 verification of backend-signed tickets and appraisals. Each inheriting contract has its own domain.
abstract contract TicketVerifier is EIP712 {
    address public signer;

    event SignerUpdated(address signer);

    error Expired();
    error BadSignature();

    constructor(string memory domainName, address signer_) EIP712(domainName, "1") {
        signer = signer_;
        emit SignerUpdated(signer_);
    }

    /// @notice EIP-712 digest of a ticket under this contract's domain.
    function ticketDigest(Tickets.Ticket memory t) public view returns (bytes32) {
        return _hashTypedDataV4(Tickets.hash(t));
    }

    /// @notice EIP-712 digest of an appraisal under this contract's domain.
    function appraisalDigest(Tickets.Appraisal memory a) public view returns (bytes32) {
        return _hashTypedDataV4(Tickets.hash(a));
    }

    function _setSigner(address s) internal {
        signer = s;
        emit SignerUpdated(s);
    }

    function _verifyTicket(Tickets.Ticket memory t, bytes memory sig) internal view {
        if (block.timestamp > t.expiresAt) revert Expired();
        _checkSigner(ticketDigest(t), sig);
    }

    function _verifyAppraisal(Tickets.Appraisal memory a, bytes memory sig) internal view {
        if (block.timestamp > a.expiresAt) revert Expired();
        _checkSigner(appraisalDigest(a), sig);
    }

    function _checkSigner(bytes32 digest, bytes memory sig) private view {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();
    }
}
