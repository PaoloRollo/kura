// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ShardMarket} from "../../src/ShardMarket.sol";
import {ShardToken} from "../../src/ShardToken.sol";

/// @notice Local Uniswap v4 (PoolManager, PositionManager, Permit2) with a ShardMarket whose vault is this test contract.
/// USDC is a 6-decimal mock placed mid-address-space so shard tokens can be put on either side of it.
abstract contract MarketTest is Test, Deployers, DeployPermit2 {
    uint160 constant FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
    address constant USDC_ADDR = address(0x8000000000000000000000000000000000000000);
    address constant LOW = address(0x1000000000000000000000000000000000000000);
    address constant HIGH = address(0xf000000000000000000000000000000000000000);

    IAllowanceTransfer permit2;
    IPositionManager posm;
    MockERC20 usdc;
    ShardMarket mkt;
    uint256 tokenNonce;

    address lp = makeAddr("lpOwner");
    address trader = makeAddr("trader");

    function setUp() public virtual {
        deployFreshManagerAndRouters();
        permit2 = IAllowanceTransfer(deployPermit2());
        posm = IPositionManager(
            address(new PositionManager(manager, permit2, 100_000, IPositionDescriptor(address(0)), IWETH9(address(0))))
        );
        deployCodeTo("lib/v4-periphery/lib/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol:MockERC20", abi.encode("USD Coin", "USDC", uint8(6)), USDC_ADDR);
        usdc = MockERC20(USDC_ADDR);
        address hookAddr = address(FLAGS | (uint160(0x4444) << 144));
        deployCodeTo("ShardMarket.sol:ShardMarket", abi.encode(manager, posm, permit2, address(this), USDC_ADDR), hookAddr);
        mkt = ShardMarket(hookAddr);
    }

    /// @dev A fresh shard token (vault = this test) below or above USDC.
    function _shardToken(bool below) internal returns (ShardToken t) {
        address at = address(uint160(below ? LOW : HIGH) + uint160(++tokenNonce));
        deployCodeTo("ShardToken.sol:ShardToken", abi.encode("Shard", "SHARD", address(this)), at);
        t = ShardToken(at);
    }

    /// @dev Q96 USDC-units-per-shard-unit price for `usdcPerShard` (6 dp) per whole shard.
    function _q96(uint256 usdcPerShard) internal pure returns (uint256) {
        return usdcPerShard * 2 ** 96 / 1e18;
    }

    /// @dev Plays the vault's part of settle: hand the tokens over, then seed.
    function _seed(uint256 cardId, ShardToken t, uint256 usdcPerShard, uint256 shards, uint256 usdcAmt) internal {
        t.mint(address(mkt), shards);
        usdc.mint(address(mkt), usdcAmt);
        mkt.seed(cardId, address(t), _q96(usdcPerShard), lp, shards, usdcAmt);
    }

    function _key(uint256 cardId) internal view returns (PoolKey memory k) {
        (address c0, address c1, uint24 fee, int24 spacing, address hooks) = mkt.poolKeyOf(cardId);
        k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(hooks));
    }

    function _shardIs0(uint256 cardId) internal view returns (bool) {
        (, address c1,,,) = mkt.poolKeyOf(cardId);
        return c1 == USDC_ADDR;
    }

    /// @dev Full-range liquidity from `who` through the v4-core test router (the router owns the position; salt tells
    /// positions apart). Positive `liquidity` adds, negative removes.
    function _outsideLiquidity(address who, uint256 cardId, int256 liquidity, bytes32 salt) internal returns (BalanceDelta d) {
        PoolKey memory k = _key(cardId);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(k.currency0)).approve(address(modifyLiquidityRouter), type(uint256).max);
        MockERC20(Currency.unwrap(k.currency1)).approve(address(modifyLiquidityRouter), type(uint256).max);
        d = modifyLiquidityRouter.modifyLiquidity(
            k, IPoolManager.ModifyLiquidityParams({tickLower: -887200, tickUpper: 887200, liquidityDelta: liquidity, salt: salt}), ""
        );
        vm.stopPrank();
    }

    /// @dev Exact-in swap by `who` through the v4-core test router. Buying spends USDC, selling spends shards.
    function _swap(address who, uint256 cardId, bool buyShards, uint256 amountIn) internal returns (BalanceDelta d) {
        PoolKey memory k = _key(cardId);
        bool shardIs0 = _shardIs0(cardId);
        bool zeroForOne = buyShards ? !shardIs0 : shardIs0;
        Currency cin = zeroForOne ? k.currency0 : k.currency1;
        vm.startPrank(who);
        MockERC20(Currency.unwrap(cin)).approve(address(swapRouter), amountIn);
        d = swapRouter.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }
}
