// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Enhanced Access Control role bitmaps copied from ensdomains/contracts-v2 at 71a3b73:
/// src/access-control/libraries/EACBaseRolesLib.sol, src/registry/libraries/RegistryRolesLib.sol and
/// src/resolver/libraries/PermissionedResolverLib.sol. Each role is one nybble; its admin bit sits 128 positions higher.
///
/// Registry roles are checked on the root resource or on a name's token resource. Resolver roles are checked on the
/// root resource (any name, any key) or on a per-argument resource, `uint256(keccak256(bytes(key)))` for text records,
/// which covers that key on every name in the resolver. Per-argument rights are granted with `grantSetterRoles`.
library EnsRoles {
    /// EACBaseRolesLib.ALL_ROLES: one unit in every regular and admin nybble.
    uint256 internal constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;

    // registry roles (RegistryRolesLib)
    uint256 internal constant REG_REGISTRAR = 1 << 0;
    uint256 internal constant REG_REGISTER_RESERVED = 1 << 4;
    uint256 internal constant REG_SET_PARENT = 1 << 8;
    uint256 internal constant REG_UNREGISTER = 1 << 12;
    uint256 internal constant REG_RENEW = 1 << 16;
    uint256 internal constant REG_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant REG_SET_RESOLVER = 1 << 24;
    uint256 internal constant REG_CAN_TRANSFER_ADMIN = (1 << 28) << 128;
    uint256 internal constant REG_UPGRADE = 1 << 124;

    // resolver roles (PermissionedResolverLib)
    uint256 internal constant RES_SET_ADDR = 1 << 0; // ROLE_SET_ADDRESS
    uint256 internal constant RES_SET_TEXT = 1 << 4;
    uint256 internal constant RES_LINK = 1 << 28;
    uint256 internal constant RES_UPGRADE = 1 << 124;

    /// CardNames on the vault's registry: issue, renew and revoke card names.
    uint256 internal constant CARD_NAMES_REGISTRY_ROLES = REG_REGISTRAR | REG_UNREGISTER | REG_RENEW;
    /// CardNames on the shared resolver: write every text and address record, and grant per-key text rights to the
    /// vendor and appraiser (the admin bits).
    uint256 internal constant CARD_NAMES_RESOLVER_ROLES =
        RES_SET_ADDR | RES_SET_TEXT | (RES_SET_ADDR << 128) | (RES_SET_TEXT << 128);
    /// Card subnames: owned by CardNames, non-transferable (no CAN_TRANSFER_ADMIN), resolver changeable.
    uint256 internal constant CARD_TOKEN_ROLES = REG_SET_RESOLVER;
    /// Collector handles: owned by the collector, transferable, resolver changeable.
    uint256 internal constant COLLECTOR_TOKEN_ROLES =
        REG_SET_RESOLVER | (REG_SET_RESOLVER << 128) | REG_CAN_TRANSFER_ADMIN;

    /// EVM mainnet coin type (ENSIP-9), the `addr(node)` record.
    uint256 internal constant COIN_TYPE_ETH = 60;

    /// EAC resource guarding one text key on a PermissionedResolver (PermissionedResolverLib.resource(string)).
    function textResource(string memory key) internal pure returns (uint256) {
        return uint256(keccak256(bytes(key)));
    }
}
