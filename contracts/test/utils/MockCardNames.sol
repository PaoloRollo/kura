// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICardNames} from "../../src/interfaces/ICardNames.sol";

contract MockCardNames is ICardNames {
    uint256 public registerCount;
    uint256 private _lastCardId;
    string private _lastLabel;
    address private _lastOwner;
    CardRecords private _lastRecords;

    uint256 private _stateCardId;
    string private _state;
    address private _stateShardToken;
    address private _stateAuction;
    uint256 private _stateClearing;

    mapping(uint256 => address) public ownerRecords;
    mapping(uint256 => bool) public revoked;

    function registerCard(uint256 cardId, string calldata label, address owner, CardRecords calldata records) external {
        registerCount++;
        _lastCardId = cardId;
        _lastLabel = label;
        _lastOwner = owner;
        _lastRecords = records;
        ownerRecords[cardId] = owner;
    }

    function setState(uint256 cardId, string calldata state, address shardToken, address auction, uint256 clearingUsdcPerShard)
        external
    {
        _stateCardId = cardId;
        _state = state;
        _stateShardToken = shardToken;
        _stateAuction = auction;
        _stateClearing = clearingUsdcPerShard;
    }

    function setOwnerRecord(uint256 cardId, address owner) external {
        ownerRecords[cardId] = owner;
    }

    function revoke(uint256 cardId) external {
        revoked[cardId] = true;
    }

    function lastRegister() external view returns (uint256, string memory, address, CardRecords memory) {
        return (_lastCardId, _lastLabel, _lastOwner, _lastRecords);
    }

    function lastState() external view returns (uint256, string memory, address, address, uint256) {
        return (_stateCardId, _state, _stateShardToken, _stateAuction, _stateClearing);
    }
}
