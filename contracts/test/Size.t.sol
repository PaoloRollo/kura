// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CardVault} from "../src/CardVault.sol";

/// CardVault sits close to the EIP-170 limit. `type(CardVault).runtimeCode` is unavailable because the vault has
/// immutables, so the check measures a deployed instance.
contract SizeTest is Test {
    function test_cardVaultFitsEip170() public {
        address x = makeAddr("x");
        CardVault v = new CardVault(
            CardVault.Config({
                owner: x,
                vendor: x,
                feeBps: 0,
                payout: x,
                signer: x,
                usdc: x,
                ccaFactory: x,
                hook: x,
                names: x,
                baseURI: "",
                siteURI: ""
            })
        );
        assertLt(address(v).code.length, 24_576);
    }
}
