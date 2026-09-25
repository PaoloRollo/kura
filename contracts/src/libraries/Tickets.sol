// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice EIP-712 structs signed by the Kura backend signer.
library Tickets {
    uint8 internal constant KIND_HUMAN = 1; // World ID Proof of Human: vendor-free bidding gate
    uint8 internal constant KIND_PASSPORT = 2; // World ID Passport: physical release

    struct Ticket {
        uint8 kind;
        address subject;
        uint256 nullifier;
        uint256 expiresAt;
    }

    struct Appraisal {
        uint256 cardId;
        address shardToken;
        uint256 usdcPerShard;
        uint256 expiresAt;
    }

    bytes32 internal constant TICKET_TYPEHASH =
        keccak256("Ticket(uint8 kind,address subject,uint256 nullifier,uint256 expiresAt)");
    bytes32 internal constant APPRAISAL_TYPEHASH =
        keccak256("Appraisal(uint256 cardId,address shardToken,uint256 usdcPerShard,uint256 expiresAt)");

    function hash(Ticket memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(TICKET_TYPEHASH, t.kind, t.subject, t.nullifier, t.expiresAt));
    }

    function hash(Appraisal memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(APPRAISAL_TYPEHASH, a.cardId, a.shardToken, a.usdcPerShard, a.expiresAt));
    }
}
