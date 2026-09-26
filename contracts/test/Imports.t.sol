// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IValidationHook} from "@cca/interfaces/IValidationHook.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

contract ImportsTest is Test {
    function test_validationHookInterfaceId() public pure {
        assertEq(type(IValidationHook).interfaceId, bytes4(0x22c44b5f));
    }

    /// The action codes are what the deployed Sepolia PositionManager and Universal Router decode.
    function test_v4ActionCodes() public pure {
        assertEq(Actions.INCREASE_LIQUIDITY, 0x00);
        assertEq(Actions.DECREASE_LIQUIDITY, 0x01);
        assertEq(Actions.MINT_POSITION, 0x02);
        assertEq(Actions.BURN_POSITION, 0x03);
        assertEq(Actions.SWAP_EXACT_IN_SINGLE, 0x06);
        assertEq(Actions.SETTLE_ALL, 0x0c);
        assertEq(Actions.SETTLE_PAIR, 0x0d);
        assertEq(Actions.TAKE_ALL, 0x0f);
        assertEq(Actions.TAKE_PAIR, 0x11);
        assertEq(Actions.SWEEP, 0x14);
    }

    function test_v4PeripheryTypesCompile() public pure {
        assertTrue(IPositionManager.modifyLiquidities.selector != bytes4(0));
        assertTrue(BaseHook.getHookPermissions.selector != bytes4(0));
        assertEq(Hooks.BEFORE_SWAP_FLAG, 1 << 7);
        assertTrue(HookMiner.FLAG_MASK != 0);
    }
}
