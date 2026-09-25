// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ShardToken} from "../src/ShardToken.sol";

contract ShardTokenTest is Test {
    address vault = makeAddr("vault");
    address alice = makeAddr("alice");
    ShardToken token;

    function setUp() public {
        token = new ShardToken("Shard black-lotus-lea-1", "SHARD", vault);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Shard black-lotus-lea-1");
        assertEq(token.symbol(), "SHARD");
        assertEq(token.decimals(), 18);
        assertEq(token.vault(), vault);
    }

    function test_vaultCanMintAndBurn() public {
        vm.prank(vault);
        token.mint(alice, 16e18);
        assertEq(token.balanceOf(alice), 16e18);
        assertEq(token.totalSupply(), 16e18);
        vm.prank(vault);
        token.burn(alice, 6e18);
        assertEq(token.balanceOf(alice), 10e18);
        assertEq(token.totalSupply(), 10e18);
    }

    function test_nonVaultCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(ShardToken.OnlyVault.selector);
        token.mint(alice, 1e18);
    }

    function test_nonVaultCannotBurn() public {
        vm.prank(vault);
        token.mint(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(ShardToken.OnlyVault.selector);
        token.burn(alice, 1e18);
    }

    function test_holdersCanTransferFreely() public {
        vm.prank(vault);
        token.mint(alice, 2e18);
        address bob = makeAddr("bob");
        vm.prank(alice);
        token.transfer(bob, 5e17);
        assertEq(token.balanceOf(bob), 5e17);
    }
}
