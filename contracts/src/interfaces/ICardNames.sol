// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ENSv2 adapter consumed by CardVault. Isolates every ENS call so the vault can be unit tested with a mock.
interface ICardNames {
    struct CardRecords {
        string scryfallId;
        string condition;
        string language;
        string imageUrl;
        string description;
        string url;
    }

    function registerCard(uint256 cardId, string calldata label, address owner, CardRecords calldata records) external;
    function setState(uint256 cardId, string calldata state, address shardToken, address auction, uint256 clearingUsdcPerShard)
        external;
    function setOwnerRecord(uint256 cardId, address owner) external;
    function revoke(uint256 cardId) external;
}
