// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DnsName} from "../src/libraries/DnsName.sol";

/// @dev Exposes the internal library function externally so vm.expectRevert can observe its revert.
contract DnsNameHarness {
    function addLabel(string memory label, bytes memory parentDns) external pure returns (bytes memory) {
        return DnsName.addLabel(label, parentDns);
    }
}

contract DnsNameTest is Test {
    DnsNameHarness harness = new DnsNameHarness();

    function test_ethNodeMatchesNamehash() public pure {
        assertEq(DnsName.ETH_NODE, keccak256(abi.encodePacked(bytes32(0), keccak256("eth"))));
    }

    function test_ethName() public pure {
        assertEq(DnsName.ethName("kura"), hex"046b7572610365746800");
    }

    function test_addLabel() public pure {
        bytes memory n = DnsName.addLabel("black-lotus-lea-1", DnsName.ethName("kura"));
        assertEq(uint8(n[0]), 17);
        assertEq(n.length, 1 + 17 + 1 + 4 + 1 + 3 + 1);
    }

    function test_nodeChains() public pure {
        bytes32 kura = DnsName.node(DnsName.ETH_NODE, "kura");
        bytes32 card = DnsName.node(kura, "black-lotus-lea-1");
        assertEq(card, keccak256(abi.encodePacked(kura, keccak256("black-lotus-lea-1"))));
    }

    function test_emptyLabelReverts() public {
        vm.expectRevert(DnsName.LabelTooLong.selector);
        harness.addLabel("", hex"00");
    }

    function test_overlongLabelReverts() public {
        vm.expectRevert(DnsName.LabelTooLong.selector);
        harness.addLabel(string(new bytes(256)), hex"00");
    }
}
