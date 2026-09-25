// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IValidationHook} from "@cca/interfaces/IValidationHook.sol";

contract ImportsTest is Test {
    function test_validationHookInterfaceId() public pure {
        assertEq(type(IValidationHook).interfaceId, bytes4(0x22c44b5f));
    }
}
