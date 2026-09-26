// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICardNames} from "./interfaces/ICardNames.sol";
import {EnsGrant, IENSRegistryV2, IENSResolverV2, IVerifiableFactory} from "./interfaces/IENSv2.sol";
import {EnsRoles} from "./libraries/EnsRoles.sol";
import {DnsName} from "./libraries/DnsName.sol";

/// @notice ENSv2 adapter for Kura. Issues one non-transferable subname per card under the vault's name, keeps its
/// records in sync with vault state, delegates scoped record rights to the vendor and the appraiser agent, revokes the
/// name on physical release, and lets collectors claim a dash-free handle with their own permissioned resolver.
/// @dev PermissionedResolver records are written by DNS-encoded name. Its per-argument rights are keyed by the text key
/// alone, so the vendor's `condition`/`grade` and the appraiser's `appraisal.usd`/`appraisal.at` rights cover every
/// name on the shared resolver (all of them card names or the appraiser's own name) and are granted once, on the first
/// card registered after the parties are set.
contract CardNames is ICardNames, IERC1155Receiver, Ownable {
    using Strings for uint256;
    using Strings for address;

    struct Config {
        address owner;
        address vault;
        address registry;
        address resolver;
        address factory;
        address resolverImpl;
        string parentLabel;
        address vendor;
        address appraiser;
    }

    uint64 public constant NAME_TTL = 3650 days;
    uint256 public constant MIN_HANDLE = 3;
    uint256 public constant MAX_HANDLE = 32;

    IENSRegistryV2 public immutable registry;
    IENSResolverV2 public immutable resolver;
    IVerifiableFactory public immutable factory;
    address public immutable resolverImpl;
    bytes32 public immutable parentNode;

    bytes public parentDns;
    string public parentLabel;
    address public vault;
    address public vendor;
    address public appraiser;

    mapping(uint256 cardId => string label) public cardLabels;
    mapping(address collector => string label) public collectorLabels;
    mapping(bytes32 labelHash => bool) public reserved;
    /// @notice Whether the current vendor and appraiser hold their per-key text rights on the shared resolver.
    bool public partiesGranted;

    event CardNamed(uint256 indexed cardId, string label, bytes32 node);
    event CardNameRevoked(uint256 indexed cardId, string label);
    event CollectorNamed(address indexed collector, string label, address resolver, bytes32 node);
    event VaultUpdated(address vault);
    event PartiesUpdated(address vendor, address appraiser);

    error OnlyVault();
    error InvalidHandle();
    error HandleReserved();
    error HandleTaken();
    error AlreadyNamed();
    error UnknownCard();
    error UnexpectedToken();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(Config memory c) Ownable(c.owner) {
        registry = IENSRegistryV2(c.registry);
        resolver = IENSResolverV2(c.resolver);
        factory = IVerifiableFactory(c.factory);
        resolverImpl = c.resolverImpl;
        parentLabel = c.parentLabel;
        parentDns = DnsName.ethName(c.parentLabel);
        parentNode = DnsName.node(DnsName.ETH_NODE, c.parentLabel);
        vault = c.vault;
        vendor = c.vendor;
        appraiser = c.appraiser;

        string[9] memory r = ["appraiser", "vault", "vendor", "admin", "www", "app", "api", "ens", "eth"];
        for (uint256 i = 0; i < r.length; i++) {
            reserved[keccak256(bytes(r[i]))] = true;
        }
    }

    // ---------------------------------------------------------------- admin

    /// @notice Point the adapter at a new CardVault (the only writer of card names). Owner only.
    function setVault(address v) external onlyOwner {
        vault = v;
        emit VaultUpdated(v);
    }

    /// @notice Set the vendor and appraiser agent that hold scoped record rights on card names. Owner only. Once rights
    /// have been granted, the previous parties lose theirs and the new ones receive them in the same call.
    function setParties(address vendor_, address appraiser_) external onlyOwner {
        if (partiesGranted) _setPartyRoles(false);
        vendor = vendor_;
        appraiser = appraiser_;
        if (partiesGranted) _setPartyRoles(true);
        emit PartiesUpdated(vendor_, appraiser_);
    }

    // ---------------------------------------------------------------- views

    /// @notice Namehash of `<label>.<parent>.eth`.
    function nodeOf(string memory label) public view returns (bytes32) {
        return DnsName.node(parentNode, label);
    }

    /// @notice DNS wire-format encoding of `<label>.<parent>.eth`.
    function dnsOf(string memory label) public view returns (bytes memory) {
        return DnsName.addLabel(label, parentDns);
    }

    /// @notice A label is available when it has never been registered or has expired.
    function isAvailable(string memory label) public view returns (bool) {
        return registry.findExpiry(label) <= uint64(block.timestamp);
    }

    // ---------------------------------------------------------------- cards (vault only)

    /// @notice Issue `<label>.<parent>.eth` for `cardId`, owned by this adapter (non-transferable), write its records
    /// and address, and delegate condition/grade to the vendor and appraisal keys to the appraiser. Vault only.
    function registerCard(uint256 cardId, string calldata label, address owner, CardRecords calldata r)
        external
        onlyVault
    {
        registry.register(label, address(this), address(0), address(resolver), EnsRoles.CARD_TOKEN_ROLES, _expiry());

        bytes memory dns = dnsOf(label);
        bytes[] memory calls = new bytes[](8);
        calls[0] = _text(dns, "avatar", r.imageUrl);
        calls[1] = _text(dns, "description", r.description);
        calls[2] = _text(dns, "url", r.url);
        calls[3] = _text(dns, "scryfall", r.scryfallId);
        calls[4] = _text(dns, "condition", r.condition);
        calls[5] = _text(dns, "language", r.language);
        calls[6] = _text(dns, "vault.state", "whole");
        calls[7] = _addrCall(dns, owner);
        resolver.multicall(calls);

        if (!partiesGranted) {
            partiesGranted = true;
            _setPartyRoles(true);
        }

        cardLabels[cardId] = label;
        emit CardNamed(cardId, label, nodeOf(label));
    }

    /// @notice Mirror the vault lifecycle state, shard token, auction and clearing price into the card records. Vault only.
    function setState(
        uint256 cardId,
        string calldata state,
        address shardToken,
        address auction,
        uint256 clearingUsdcPerShard
    ) external onlyVault {
        bytes memory dns = _dnsOfCard(cardId);
        bytes[] memory calls = new bytes[](4);
        calls[0] = _text(dns, "vault.state", state);
        calls[1] = _text(dns, "vault.shards", _addrString(shardToken));
        calls[2] = _text(dns, "vault.auction", _addrString(auction));
        calls[3] = _text(dns, "vault.clearing_usdc", clearingUsdcPerShard.toString());
        resolver.multicall(calls);
    }

    /// @notice Point the card name's address record at its current beneficial owner. Vault only.
    function setOwnerRecord(uint256 cardId, address owner) external onlyVault {
        resolver.setAddress(_dnsOfCard(cardId), EnsRoles.COIN_TYPE_ETH, abi.encodePacked(owner));
    }

    /// @notice Unregister the card name on physical release. Vault only.
    function revoke(uint256 cardId) external onlyVault {
        string memory label = cardLabels[cardId];
        if (bytes(label).length == 0) revert UnknownCard();
        registry.unregister(uint256(keccak256(bytes(label))));
        delete cardLabels[cardId];
        emit CardNameRevoked(cardId, label);
    }

    // ---------------------------------------------------------------- collectors (anyone)

    /// @notice Claim `<label>.<parent>.eth` with a resolver you fully control. One handle per wallet.
    function registerCollector(string calldata label) external returns (address collectorResolver) {
        _requireHandle(label);
        if (reserved[keccak256(bytes(label))]) revert HandleReserved();
        if (!isAvailable(label)) revert HandleTaken();
        if (bytes(collectorLabels[msg.sender]).length != 0) revert AlreadyNamed();

        // The resolver's initializer runs its setter calls without permission checks, so the address record is
        // written during deployment and the collector is the sole admin from the first block. CardNames holds no role.
        EnsGrant[] memory grants = new EnsGrant[](1);
        grants[0] = EnsGrant({account: msg.sender, roleBitmap: EnsRoles.ALL_ROLES});
        bytes[] memory setters = new bytes[](1);
        setters[0] = _addrCall(dnsOf(label), msg.sender);
        collectorResolver = factory.deployProxy(
            resolverImpl,
            uint256(keccak256(abi.encode(label, msg.sender))),
            abi.encodeCall(IENSResolverV2.initialize, (grants, setters))
        );

        registry.register(label, msg.sender, address(0), collectorResolver, EnsRoles.COLLECTOR_TOKEN_ROLES, _expiry());
        collectorLabels[msg.sender] = label;
        emit CollectorNamed(msg.sender, label, collectorResolver, nodeOf(label));
    }

    // ---------------------------------------------------------------- ERC1155 receiver

    /// @notice ENSv2 registries are ERC1155 and safe-mint the card name token to its owner (this contract). Only name
    /// tokens from the vault's registry are accepted; there is no path to move them out again.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(registry)) revert UnexpectedToken();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    /// @notice Batch variant of {onERC1155Received}; same registry-only rule.
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(registry)) revert UnexpectedToken();
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    /// @notice ERC165: advertises IERC1155Receiver.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ---------------------------------------------------------------- internals

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp) + NAME_TTL;
    }

    function _dnsOfCard(uint256 cardId) internal view returns (bytes memory) {
        string memory label = cardLabels[cardId];
        if (bytes(label).length == 0) revert UnknownCard();
        return dnsOf(label);
    }

    function _text(bytes memory dns, string memory key, string memory value) internal pure returns (bytes memory) {
        return abi.encodeCall(IENSResolverV2.setText, (dns, key, value));
    }

    function _addrCall(bytes memory dns, address a) internal pure returns (bytes memory) {
        return abi.encodeCall(IENSResolverV2.setAddress, (dns, EnsRoles.COIN_TYPE_ETH, abi.encodePacked(a)));
    }

    /// @dev Grant (or revoke) the vendor's condition/grade and the appraiser's appraisal.* text rights.
    function _setPartyRoles(bool grant) internal {
        _setKeyRole("condition", vendor, grant);
        _setKeyRole("grade", vendor, grant);
        _setKeyRole("appraisal.usd", appraiser, grant);
        _setKeyRole("appraisal.at", appraiser, grant);
    }

    function _setKeyRole(string memory key, address account, bool grant) internal {
        if (account == address(0)) return;
        if (grant) {
            resolver.grantSetterRoles(_text("", key, ""), account);
        } else {
            resolver.revokeRoles(EnsRoles.textResource(key), EnsRoles.RES_SET_TEXT, account);
        }
    }

    function _addrString(address a) internal pure returns (string memory) {
        return a == address(0) ? "" : a.toHexString();
    }

    function _requireHandle(string calldata s) internal pure {
        bytes memory b = bytes(s);
        if (b.length < MIN_HANDLE || b.length > MAX_HANDLE) revert InvalidHandle();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool digit = ch >= 0x30 && ch <= 0x39;
            bool lower = ch >= 0x61 && ch <= 0x7a;
            if (!digit && !lower) revert InvalidHandle();
        }
    }
}
