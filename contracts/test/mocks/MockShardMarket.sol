// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IShardMarket} from "../../src/interfaces/IShardMarket.sol";
import {CardVault} from "../../src/CardVault.sol";

/// @notice Records CardVault's calls into the shard market and holds what it is handed, without any Uniswap pool.
/// `give` stands in for trading: tests use it to move the "pool's" shards to a buyer.
contract MockShardMarket is IShardMarket {
    struct SeedCall {
        uint256 cardId;
        address shardToken;
        uint256 clearingPriceQ96;
        address lpOwner;
        uint256 shardAmount;
        uint256 usdcAmount;
        uint256 shardBalance; // this contract's balance of the shard token when seed ran
        uint256 usdcBalance; // this contract's USDC balance when seed ran
    }

    address public immutable vault;
    IERC20 public immutable usdc;

    uint256 public seedCount;
    SeedCall internal _lastSeed;
    mapping(uint256 cardId => address) internal _token;
    mapping(uint256 cardId => address) internal _lpOwner;

    uint256 public unwindCount;
    uint256 public lastUnwound;
    CardVault.State public stateAtUnwind;
    uint256 public redeemerBalanceAtUnwind;

    constructor(address vault_, address usdc_) {
        vault = vault_;
        usdc = IERC20(usdc_);
    }

    function lastSeed() external view returns (SeedCall memory) {
        return _lastSeed;
    }

    function give(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }

    function seed(uint256 cardId, address shardToken, uint256 clearingPriceQ96, address lpOwner, uint256 shardAmount, uint256 usdcAmount)
        external
    {
        if (msg.sender != vault) revert OnlyVault();
        seedCount++;
        _lastSeed = SeedCall({
            cardId: cardId,
            shardToken: shardToken,
            clearingPriceQ96: clearingPriceQ96,
            lpOwner: lpOwner,
            shardAmount: shardAmount,
            usdcAmount: usdcAmount,
            shardBalance: IERC20(shardToken).balanceOf(address(this)),
            usdcBalance: usdc.balanceOf(address(this))
        });
        _token[cardId] = shardToken;
        _lpOwner[cardId] = lpOwner;
    }

    function collectFees(uint256) external pure {}

    /// @dev Like the real market: hands whatever it still holds for the card back to the LP owner.
    function unwind(uint256 cardId) external {
        if (msg.sender != vault) revert OnlyVault();
        unwindCount++;
        lastUnwound = cardId;
        CardVault.Card memory c = CardVault(vault).cards(cardId);
        stateAtUnwind = c.state;
        address token = _token[cardId];
        if (token == address(0)) return;
        redeemerBalanceAtUnwind = IERC20(token).balanceOf(c.beneficialOwner);
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(_lpOwner[cardId], bal);
    }

    function poolKeyOf(uint256) external pure returns (address, address, uint24, int24, address) {}
    function poolIdOf(uint256) external pure returns (bytes32) {}
    function cardIdOfPool(bytes32) external pure returns (uint256) {}

    function lpOwnerOf(uint256 cardId) external view returns (address) {
        return _lpOwner[cardId];
    }

    function isFrozen(uint256) external pure returns (bool) {}
    function positionsOf(uint256) external pure returns (uint256[] memory) {}
}
