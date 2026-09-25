// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Enhanced Access Control role bitmaps copied from contracts-v2 (RegistryRolesLib, PermissionedResolverLib,
/// EACBaseRolesLib). Admin bits sit 128 positions above their role bit.
library EnsRoles {
    uint256 internal constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;

    // registry roles
    uint256 internal constant REG_REGISTRAR = 1 << 0;
    uint256 internal constant REG_SET_PARENT = 1 << 8;
    uint256 internal constant REG_UNREGISTER = 1 << 12;
    uint256 internal constant REG_RENEW = 1 << 16;
    uint256 internal constant REG_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant REG_SET_RESOLVER = 1 << 24;
    uint256 internal constant REG_CAN_TRANSFER_ADMIN = (1 << 28) << 128;

    // resolver roles
    uint256 internal constant RES_SET_ADDR = 1 << 0;
    uint256 internal constant RES_SET_TEXT = 1 << 4;

    /// CardNames on the vault's registry: issue, renew and revoke card names.
    uint256 internal constant CARD_NAMES_REGISTRY_ROLES = REG_REGISTRAR | REG_UNREGISTER | REG_RENEW;
    /// CardNames on the shared resolver: write records and delegate per-key rights (admin bits).
    uint256 internal constant CARD_NAMES_RESOLVER_ROLES =
        RES_SET_ADDR | RES_SET_TEXT | (RES_SET_ADDR << 128) | (RES_SET_TEXT << 128);
    /// Card subnames: owned by CardNames, non-transferable (no CAN_TRANSFER_ADMIN), resolver changeable.
    uint256 internal constant CARD_TOKEN_ROLES = REG_SET_RESOLVER;
    /// Collector handles: owned by the collector, transferable, resolver changeable.
    uint256 internal constant COLLECTOR_TOKEN_ROLES =
        REG_SET_RESOLVER | (REG_SET_RESOLVER << 128) | REG_CAN_TRANSFER_ADMIN;
}
