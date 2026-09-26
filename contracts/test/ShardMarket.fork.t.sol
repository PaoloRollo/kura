// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkTest} from "./utils/ForkTest.sol";
import {ShardMarket} from "../src/ShardMarket.sol";
import {ShardToken} from "../src/ShardToken.sol";
import {Tickets} from "../src/libraries/Tickets.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {ICCAAuction, IPermit2} from "../src/interfaces/ICCA.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice The shard market against the contracts the app talks to on Sepolia: the pool seeded by a real settle, priced
/// through StateView and the V4 Quoter, traded through the Universal Router with Permit2, then bought out and frozen.
/// Proves the v4 addresses and ABIs in deployments/sepolia.json match what is deployed. Skipped without SEPOLIA_RPC_URL.
contract ShardMarketForkTest is ForkTest {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    address constant POSM = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    IUniversalRouter constant UR = IUniversalRouter(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);
    IStateView constant STATE_VIEW = IStateView(0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C);
    IV4Quoter constant QUOTER = IV4Quoter(0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227);
    uint8 constant V4_SWAP = 0x10;
    uint160 constant FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    ShardMarket sm;
    address erin = makeAddr("erin");
    uint256 id;
    address shardToken;
    address auction;

    function setUp() public override {
        if (!vm.envExists("SEPOLIA_RPC_URL")) vm.skip(true);
        super.setUp();
        id = _mintTo(alice);
    }

    /// @dev Deployed the way Deploy.s.sol does it: a mined salt, so the address carries the hook flags.
    function _deployMarket() internal override returns (address) {
        bytes memory args = abi.encode(PM, POSM, PERMIT2, address(vault), address(USDC));
        (address mined, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(ShardMarket).creationCode, args);
        sm = new ShardMarket{salt: salt}(PM, IPositionManager(POSM), IAllowanceTransfer(PERMIT2), address(vault), address(USDC));
        assertEq(address(sm), mined);
        return mined;
    }

    function _key() internal view returns (PoolKey memory k) {
        (address c0, address c1, uint24 fee, int24 spacing, address hooks) = sm.poolKeyOf(id);
        k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(hooks));
    }

    function _shardIs0() internal view returns (bool) {
        return shardToken < address(USDC);
    }

    function test_tradeThroughUniversalRouterAndBuyOut() public {
        _settleWithBids();
        _pricesReadThroughStateView();
        uint256 bought = _buyThroughRouter(20e6);
        _sellThroughRouter(bought / 2);
        _buyThroughRouter(5_000e6); // enough to pass 80 percent
        assertGe(ShardToken(shardToken).balanceOf(erin) * 5, ShardToken(shardToken).totalSupply() * 4);
        _redeemAndFreeze();
    }

    function _settleWithBids() internal {
        vm.prank(alice);
        (shardToken, auction) = vault.shardAndAuction(id, _defaultParams());
        uint256 tick = ICCAAuction(auction).tickSpacing();
        _bid(bob, auction, tick * 22, 10e6);
        _bid(carol, auction, tick * 24, 15e6);
        vm.roll(ICCAAuction(auction).endBlock());
        vault.settle(id);
        assertTrue(sm.poolIdOf(id) != bytes32(0));
        assertEq(sm.positionsOf(id).length, 2);
    }

    function _pricesReadThroughStateView() internal view {
        PoolId pid = PoolId.wrap(sm.poolIdOf(id));
        (uint160 a, int24 ta,,) = PM.getSlot0(pid);
        (uint160 b, int24 tb,, uint24 lpFee) = STATE_VIEW.getSlot0(pid);
        assertEq(a, b);
        assertEq(ta, tb);
        assertEq(lpFee, 10_000);
        assertGt(STATE_VIEW.getLiquidity(pid), 0);
    }

    /// @dev Exact-in swap through the Universal Router, the way the app does it: quote, 1 percent slippage, Permit2.
    /// With `quote` false it skips the quoter and accepts any output (used to prove the router itself is refused).
    function _swapViaRouter(address who, bool buyShards, uint256 amountIn, bool quote) internal returns (uint256 out) {
        PoolKey memory k = _key();
        bool zeroForOne = buyShards ? !_shardIs0() : _shardIs0();
        uint256 quoted;
        if (quote) {
            (quoted,) = QUOTER.quoteExactInputSingle(
                IV4Quoter.QuoteExactSingleParams({poolKey: k, zeroForOne: zeroForOne, exactAmount: uint128(amountIn), hookData: ""})
            );
        }
        bytes[] memory inputs = _v4SwapInput(k, zeroForOne, amountIn, quoted * 99 / 100);
        (address tokenIn, address tokenOut) = zeroForOne
            ? (Currency.unwrap(k.currency0), Currency.unwrap(k.currency1))
            : (Currency.unwrap(k.currency1), Currency.unwrap(k.currency0));

        uint256 before = IERC20(tokenOut).balanceOf(who);
        vm.startPrank(who);
        IERC20(tokenIn).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(tokenIn, address(UR), uint160(amountIn), uint48(block.timestamp + 1 hours));
        UR.execute(abi.encodePacked(V4_SWAP), inputs, block.timestamp);
        vm.stopPrank();
        out = IERC20(tokenOut).balanceOf(who) - before;
        if (quote) assertEq(out, quoted, "V4 Quoter matches the Universal Router fill");
    }

    /// @dev Universal Router V4_SWAP input: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL.
    function _v4SwapInput(PoolKey memory k, bool zeroForOne, uint256 amountIn, uint256 minOut)
        internal
        pure
        returns (bytes[] memory inputs)
    {
        (Currency cin, Currency cout) = zeroForOne ? (k.currency0, k.currency1) : (k.currency1, k.currency0);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: k,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minOut),
                hookData: ""
            })
        );
        params[1] = abi.encode(cin, amountIn);
        params[2] = abi.encode(cout, minOut);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }

    function _buyThroughRouter(uint256 usdcIn) internal returns (uint256 shardsOut) {
        _dealUsdc(erin, usdcIn);
        shardsOut = _swapViaRouter(erin, true, usdcIn, true);
        assertGt(shardsOut, 0);
    }

    function _sellThroughRouter(uint256 shardsIn) internal {
        uint256 usdcOut = _swapViaRouter(erin, false, shardsIn, true);
        assertGt(usdcOut, 0);
    }

    function _redeemAndFreeze() internal {
        (Tickets.Appraisal memory a, bytes memory sig) = _appraisal(id, shardToken, 12e6);
        uint256 missing = ShardToken(shardToken).totalSupply() - ShardToken(shardToken).balanceOf(erin);
        uint256 owed = PriceMath.payoutFor(12e6, missing);
        _dealUsdc(erin, owed + owed * 250 / 10_000);
        vm.startPrank(erin);
        USDC.approve(address(vault), type(uint256).max);
        vault.redeem(id, a, sig);
        vm.stopPrank();
        assertEq(vault.ownerOf(id), erin);
        assertTrue(sm.isFrozen(id));

        // trading is closed at buyout, for the Universal Router too
        _dealUsdc(bob, 1e6);
        vm.expectRevert();
        this.routerSwap(bob, 1e6);

        // the owner claims the shards that came back from the pool
        uint256 aliceShards = ShardToken(shardToken).balanceOf(alice);
        assertGt(aliceShards, 0);
        uint256 before = USDC.balanceOf(alice);
        vm.prank(alice);
        vault.claimPayout(shardToken);
        assertEq(USDC.balanceOf(alice) - before, PriceMath.payoutFor(12e6, aliceShards));
    }

    function routerSwap(address who, uint256 usdcIn) external {
        _swapViaRouter(who, true, usdcIn, false);
    }
}
