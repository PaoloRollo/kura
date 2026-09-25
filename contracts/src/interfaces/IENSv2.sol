// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal ENSv2 interfaces (ensdomains/contracts-v2, Sepolia beta). Interface-typed parameters upstream
/// (IRegistry, IERC20) are declared as address here; the ABI is identical.

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

    function initialize(address rootAccount, uint256 roleBitmap) external;
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
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function setParent(address parent, string calldata label) external;
}

interface IENSResolverV2 {
    event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value);
    event AddrChanged(bytes32 indexed node, address a);

    function initialize(address admin, uint256 roleBitmap, bytes[] calldata setters) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function setAddr(bytes32 node, address addr_) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
    function addr(bytes32 node) external view returns (address payable);
    function multicall(bytes[] calldata calls) external returns (bytes[] memory results);
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool);
    function authorizeAddrRoles(bytes calldata toName, uint256 coinType, address account, bool grant)
        external
        returns (bool);
    function authorizeNameRoles(bytes calldata toName, uint256 roleBitmap, address account, bool grant)
        external
        returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
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
    function isAvailable(string calldata label) external view returns (bool);
    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);
    function MIN_COMMITMENT_AGE() external view returns (uint64);
}
