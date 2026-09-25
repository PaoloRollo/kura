// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ENS name helpers: namehash nodes and DNS wire-format encoding ("\x04kura\x03eth\x00").
library DnsName {
    bytes32 internal constant ETH_NODE = 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;

    error LabelTooLong();

    function node(bytes32 parentNode, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    function addLabel(string memory label, bytes memory parentDns) internal pure returns (bytes memory) {
        bytes memory l = bytes(label);
        if (l.length == 0 || l.length > 255) revert LabelTooLong();
        return abi.encodePacked(uint8(l.length), l, parentDns);
    }

    function ethName(string memory label) internal pure returns (bytes memory) {
        return addLabel(label, hex"0365746800");
    }
}
