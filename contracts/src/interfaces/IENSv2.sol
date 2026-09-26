// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal ENSv2 interfaces for ensdomains/contracts-v2 at 71a3b73 (the Sepolia deployment listed on
/// docs.ens.domains). Interface-typed parameters upstream (IRegistry, IERC20) are declared as address here; the ABI is
/// identical.

/// @notice Root role grant used by the registry and resolver initializers (`Grant` in IEACGrantInitializable.sol).
struct EnsGrant {
    address account;
    uint256 roleBitmap;
}

/// @notice UserRegistry / PermissionedRegistry (src/registry/UserRegistry.sol, PermissionedRegistry.sol).
interface IENSRegistryV2 {
    event LabelRegistered(
        uint256 indexed tokenId,
        bytes32 indexed labelHash,
        string label,
        address owner,
        uint64 expiry,
        address indexed sender
    );
    event LabelUnregistered(uint256 indexed tokenId, address indexed sender);
    event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender);

    function initialize(EnsGrant[] calldata grants) external;
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);
    function unregister(uint256 anyId) external;
    function findExpiry(string calldata label) external view returns (uint64);
    function findOwner(string calldata label) external view returns (address);
    function findTokenId(string calldata label) external view returns (uint256);
    function getResolver(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
    function getParent() external view returns (address parent, string memory label);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function setParent(address parent, string calldata label) external;
    function unsafeTransfer(address to, uint256 tokenId, bytes calldata data) external;
}

/// @notice PermissionedResolver (src/resolver/PermissionedResolver.sol). Setters take the DNS-encoded name; read
/// records through {resolve} (ENSIP-10) or the UniversalResolver.
interface IENSResolverV2 {
    event TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value);
    event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes);
    event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name);

    function initialize(EnsGrant[] calldata grants, bytes[] calldata calls) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function multicall(bytes[] calldata calls) external returns (bytes[] memory results);
    function multicallWithNodeCheck(bytes32 node, bytes[] calldata calls) external returns (bytes[] memory results);
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function getRecordId(bytes32 node) external view returns (uint256);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @notice Legacy resolver profiles, used only to build `resolve()` calldata (the node argument is ignored by
/// PermissionedResolver, which resolves by name).
interface IResolverProfiles {
    function addr(bytes32 node) external view returns (address payable);
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @notice UniversalResolverV2 (src/universalResolver/UniversalResolverV2.sol).
interface IUniversalResolverV2 {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
    function findResolver(bytes calldata name) external view returns (address resolver, bytes32 node, uint256 offset);
}

interface IVerifiableFactory {
    event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation);

    function deployProxy(address implementation, uint256 salt, bytes memory data) external returns (address proxy);
    function verifyContract(address proxy) external view returns (address implementation);
}

interface IETHRegistrar {
    function commit(bytes32 commitment) external;
    function register(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256 tokenId);
    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);
    function commitmentAt(bytes32 commitment) external view returns (uint64);
    function isAvailable(string calldata label) external view returns (bool);
    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);
    function MIN_COMMITMENT_AGE() external view returns (uint64);
    function MAX_COMMITMENT_AGE() external view returns (uint64);
}
