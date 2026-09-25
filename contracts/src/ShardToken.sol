// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice One fungible shard token per sharding of a card. Minted and burned only by the vault.
contract ShardToken is ERC20 {
    address public immutable vault;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(string memory name_, string memory symbol_, address vault_) ERC20(name_, symbol_) {
        vault = vault_;
    }

    /// @notice Mint shards. Vault only.
    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    /// @notice Burn shards from `from`. Vault only; the vault only ever burns the balance of the account acting on it.
    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
