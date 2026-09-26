// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {CardVault} from "../src/CardVault.sol";
import {CardNames} from "../src/CardNames.sol";
import {ICardNames} from "../src/interfaces/ICardNames.sol";
import {IENSRegistryV2, IENSResolverV2, IResolverProfiles} from "../src/interfaces/IENSv2.sol";
import {EnsRoles} from "../src/libraries/EnsRoles.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {EnsEnv} from "./SetupEns.s.sol";

/// @dev Record reads on the superseded ENSv2 resolver (contracts-v2 48b3e2d), which still has node-based getters.
interface ILegacyResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @notice Moves the live CardVault's card names onto the current ENSv2 deployment. Run after SetupEns has written the
/// new `deployments/sepolia.ens.json`.
///
/// 1. Deploys a new CardNames on the new registry and resolver (or reuses one from an earlier, interrupted run) and
///    grants it the same registry and resolver root roles Deploy.s.sol grants.
/// 2. For every card that is not Released, registers `<label>.<parent>.eth` exactly as CardVault.mint would (the
///    deployer stands in as the vault while it does), then reconciles every record with what the vault would have
///    written by now: address = beneficial owner, vault.* = current state, shard token, auction and price. Records the
///    vault never stores (avatar, description, and the vendor's and appraiser's keys) are copied from the old resolver.
/// 3. Points CardNames at the vault and the vault at CardNames.
///
/// Idempotent: every step checks chain state first, and records are only written where they differ, so rerunning after
/// a partial broadcast finishes the job and a rerun after success sends nothing. `forge script` without `--broadcast`
/// is the dry run; it logs every action and writes no files.
contract MigrateNames is EnsEnv {
    using Strings for uint256;
    using Strings for address;

    address constant LIVE_VAULT = 0x62FB23ec64994F658E9DD4E0FC223DdF8a7D62c2;
    address constant LIVE_OLD_NAMES = 0xF963277C91F88048d893E17d56b293a9c7f04014;

    struct Ctx {
        uint256 pk;
        address deployer;
        CardVault vault;
        CardNames oldNames;
        ILegacyResolver oldResolver;
        IENSRegistryV2 registry;
        IENSResolverV2 resolver;
        string label;
        address factory;
        address resolverImpl;
        CardNames names;
    }

    function run() external returns (CardNames) {
        require(block.chainid == 11155111, "Deploy targets Sepolia only");
        Ctx memory c = _context();

        vm.startBroadcast(c.pk);
        c.names = _names(c);
        _grantRoles(c);

        uint256 last = c.vault.nextId() - 1;
        bool standIn = _needsRegistration(c, last);
        if (standIn && c.names.vault() != c.deployer) {
            console2.log("names.setVault(deployer) for backfill");
            c.names.setVault(c.deployer);
        }
        for (uint256 id = 1; id <= last; id++) {
            _migrateCard(c, id);
        }
        if (c.names.vault() != address(c.vault)) {
            console2.log("names.setVault(vault)");
            c.names.setVault(address(c.vault));
        }
        if (address(c.vault.names()) != address(c.names)) {
            console2.log("vault.setNames(names)");
            c.vault.setNames(address(c.names));
        }
        vm.stopBroadcast();

        _write(c);
        console2.log("CardNames", address(c.names));
        return c.names;
    }

    // ---------------------------------------------------------------- setup

    function _context() internal view returns (Ctx memory c) {
        c.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.vault = CardVault(vm.envOr("KURA_VAULT", LIVE_VAULT));
        require(c.vault.owner() == c.deployer, "DEPLOYER_PRIVATE_KEY is not the vault owner");

        string memory ens = vm.readFile(string.concat(deploymentsDir(), "/sepolia.ens.json"));
        c.label = vm.parseJsonString(ens, ".label");
        c.registry = IENSRegistryV2(vm.parseJsonAddress(ens, ".registry"));
        c.resolver = IENSResolverV2(vm.parseJsonAddress(ens, ".resolver"));
        c.factory = vm.parseJsonAddress(ens, ".verifiableFactory");
        c.resolverImpl = vm.parseJsonAddress(ens, ".resolverImpl");
        require(
            IENSRegistryV2(ethRegistry()).getSubregistry(c.label) == address(c.registry),
            "sepolia.ens.json is not the registry of <label>.eth on the new ETHRegistry: run SetupEns first"
        );
        require(c.resolver.hasRootRoles(EnsRoles.ALL_ROLES, c.deployer), "deployer is not the resolver admin");

        c.oldNames = CardNames(vm.envOr("OLD_CARD_NAMES", LIVE_OLD_NAMES));
        c.oldResolver = ILegacyResolver(address(c.oldNames.resolver()));
    }

    /// @dev Reuse, in order: KURA_NEW_CARD_NAMES, the vault's current adapter, or deployments/sepolia.json's cardNames,
    /// whichever is a CardNames on the new registry. Otherwise deploy one with the old adapter's vendor and appraiser.
    function _names(Ctx memory c) internal returns (CardNames) {
        address[3] memory candidates = [
            vm.envOr("KURA_NEW_CARD_NAMES", address(0)),
            address(c.vault.names()),
            _jsonAddress(string.concat(deploymentsDir(), "/sepolia.json"), ".cardNames")
        ];
        for (uint256 i = 0; i < candidates.length; i++) {
            if (_isNewNames(c, candidates[i])) {
                console2.log("reusing CardNames", candidates[i]);
                return CardNames(candidates[i]);
            }
        }
        console2.log("deploying CardNames");
        return new CardNames(
            CardNames.Config({
                owner: c.deployer,
                vault: c.deployer,
                registry: address(c.registry),
                resolver: address(c.resolver),
                factory: c.factory,
                resolverImpl: c.resolverImpl,
                parentLabel: c.label,
                vendor: c.oldNames.vendor(),
                appraiser: c.oldNames.appraiser()
            })
        );
    }

    function _isNewNames(Ctx memory c, address a) internal view returns (bool) {
        if (a.code.length == 0) return false;
        try CardNames(a).registry() returns (IENSRegistryV2 r) {
            return address(r) == address(c.registry) && address(CardNames(a).resolver()) == address(c.resolver)
                && CardNames(a).owner() == c.deployer;
        } catch {
            return false;
        }
    }

    function _grantRoles(Ctx memory c) internal {
        address n = address(c.names);
        if (!c.registry.hasRootRoles(EnsRoles.CARD_NAMES_REGISTRY_ROLES, n)) {
            console2.log("registry.grantRootRoles(names)");
            c.registry.grantRootRoles(EnsRoles.CARD_NAMES_REGISTRY_ROLES, n);
        }
        if (!c.resolver.hasRootRoles(EnsRoles.CARD_NAMES_RESOLVER_ROLES, n)) {
            console2.log("resolver.grantRootRoles(names)");
            c.resolver.grantRootRoles(EnsRoles.CARD_NAMES_RESOLVER_ROLES, n);
        }
    }

    function _needsRegistration(Ctx memory c, uint256 last) internal view returns (bool) {
        for (uint256 id = 1; id <= last; id++) {
            if (_isLive(c.vault.cards(id)) && bytes(c.names.cardLabels(id)).length == 0) return true;
        }
        return false;
    }

    function _isLive(CardVault.Card memory card) internal pure returns (bool) {
        return card.state != CardVault.State.None && card.state != CardVault.State.Released;
    }

    // ---------------------------------------------------------------- per card

    function _migrateCard(Ctx memory c, uint256 id) internal {
        CardVault.Card memory card = c.vault.cards(id);
        if (!_isLive(card)) return;
        string memory label = card.label;
        require(_endsWithId(label, id), "card label does not end in -<id>");
        bytes32 oldNode = c.oldNames.nodeOf(label);

        if (bytes(c.names.cardLabels(id)).length == 0) {
            console2.log("registerCard", id, label);
            c.names
                .registerCard(
                    id,
                    label,
                    card.beneficialOwner,
                    ICardNames.CardRecords({
                        scryfallId: card.scryfallId,
                        condition: _oldOr(c, oldNode, "condition", card.condition),
                        language: card.language,
                        imageUrl: _old(c, oldNode, "avatar"),
                        description: _old(c, oldNode, "description"),
                        url: string.concat(c.vault.siteURI(), id.toString())
                    })
                );
        }
        _reconcile(c, id, card, label, oldNode);
    }

    /// @dev Write, as the resolver admin, every record that differs from what the vault and the old resolver say.
    function _reconcile(Ctx memory c, uint256 id, CardVault.Card memory card, string memory label, bytes32 oldNode)
        internal
    {
        bytes memory dns = c.names.dnsOf(label);
        string[2][] memory want = _desiredTexts(c, id, card, oldNode);
        bytes[] memory calls = new bytes[](want.length + 1);
        uint256 n;
        for (uint256 i = 0; i < want.length; i++) {
            if (keccak256(bytes(_text(c, dns, want[i][0]))) != keccak256(bytes(want[i][1]))) {
                console2.log("  setText", id, want[i][0], want[i][1]);
                calls[n++] = abi.encodeCall(IENSResolverV2.setText, (dns, want[i][0], want[i][1]));
            }
        }
        if (_addr(c, dns) != card.beneficialOwner) {
            console2.log("  setAddress", id, card.beneficialOwner);
            calls[n++] = abi.encodeCall(
                IENSResolverV2.setAddress, (dns, EnsRoles.COIN_TYPE_ETH, abi.encodePacked(card.beneficialOwner))
            );
        }
        if (n == 0) return;
        assembly {
            mstore(calls, n)
        }
        c.resolver.multicall(calls);
    }

    /// @dev The text records CardVault and the parties would have written by now, as (key, value) pairs.
    function _desiredTexts(Ctx memory c, uint256 id, CardVault.Card memory card, bytes32 oldNode)
        internal
        view
        returns (string[2][] memory t)
    {
        t = new string[2][](13);
        t[0] = ["avatar", _old(c, oldNode, "avatar")];
        t[1] = ["description", _old(c, oldNode, "description")];
        t[2] = ["url", string.concat(c.vault.siteURI(), id.toString())];
        t[3] = ["scryfall", card.scryfallId];
        t[4] = ["condition", _oldOr(c, oldNode, "condition", card.condition)];
        t[5] = ["language", card.language];
        t[6] = ["grade", _old(c, oldNode, "grade")];
        t[7] = ["appraisal.usd", _old(c, oldNode, "appraisal.usd")];
        t[8] = ["appraisal.at", _old(c, oldNode, "appraisal.at")];
        t[9] = ["vault.state", _stateName(card.state)];
        t[10] = ["vault.shards", _addrString(card.shardToken)];
        t[11] = ["vault.auction", _addrString(card.auction)];
        t[12] = ["vault.clearing_usdc", _clearing(c, card, oldNode)];
    }

    /// @dev Mirrors the price argument of the vault's last setState: 0 while auctioning, the clearing price once
    /// sharded. A Whole card's value is the buyout price of a redeemed sharding (the vault no longer points at it) or
    /// empty if the card was never sharded, so it is carried over from the old resolver.
    function _clearing(Ctx memory c, CardVault.Card memory card, bytes32 oldNode)
        internal
        view
        returns (string memory)
    {
        if (card.state == CardVault.State.Auctioning) return "0";
        if (card.state == CardVault.State.Sharded) {
            return PriceMath.q96ToUsdcPerShard(c.vault.shardings(card.shardToken).clearingPriceQ96).toString();
        }
        return _old(c, oldNode, "vault.clearing_usdc");
    }

    // ---------------------------------------------------------------- helpers

    function _stateName(CardVault.State s) internal pure returns (string memory) {
        if (s == CardVault.State.Auctioning) return "auctioning";
        if (s == CardVault.State.Sharded) return "sharded";
        return "whole";
    }

    function _addrString(address a) internal pure returns (string memory) {
        return a == address(0) ? "" : a.toHexString();
    }

    function _old(Ctx memory c, bytes32 node, string memory key) internal view returns (string memory) {
        if (address(c.oldResolver).code.length == 0) return "";
        try c.oldResolver.text(node, key) returns (string memory v) {
            return v;
        } catch {
            return "";
        }
    }

    function _oldOr(Ctx memory c, bytes32 node, string memory key, string memory fallback_)
        internal
        view
        returns (string memory)
    {
        string memory v = _old(c, node, key);
        return bytes(v).length == 0 ? fallback_ : v;
    }

    function _text(Ctx memory c, bytes memory dns, string memory key) internal view returns (string memory) {
        return abi.decode(c.resolver.resolve(dns, abi.encodeCall(IResolverProfiles.text, (bytes32(0), key))), (string));
    }

    function _addr(Ctx memory c, bytes memory dns) internal view returns (address) {
        return abi.decode(c.resolver.resolve(dns, abi.encodeCall(IResolverProfiles.addr, (bytes32(0)))), (address));
    }

    function _endsWithId(string memory label, uint256 id) internal pure returns (bool) {
        bytes memory l = bytes(label);
        bytes memory suffix = bytes(string.concat("-", id.toString()));
        if (l.length <= suffix.length) return false;
        for (uint256 i = 0; i < suffix.length; i++) {
            if (l[l.length - suffix.length + i] != suffix[i]) return false;
        }
        return true;
    }

    function _jsonAddress(string memory path, string memory key) internal view returns (address) {
        try vm.readFile(path) returns (string memory json) {
            return vm.keyExistsJson(json, key) ? vm.parseJsonAddress(json, key) : address(0);
        } catch {
            return address(0);
        }
    }

    /// @dev Point deployments/sepolia.json at the new adapter and ENS contracts. Skipped in a dry run.
    function _write(Ctx memory c) internal {
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) return;
        string memory path = string.concat(deploymentsDir(), "/sepolia.json");
        vm.writeJson(_quoted(address(c.names)), path, ".cardNames");
        vm.writeJson(_quoted(address(c.registry)), path, ".ensRegistry");
        vm.writeJson(_quoted(address(c.resolver)), path, ".ensResolver");
        vm.writeJson(string.concat('"', c.label, '"'), path, ".ensParentLabel");
        vm.writeJson(string.concat('"', vm.toString(c.names.parentNode()), '"'), path, ".ensParentNode");
    }

    function _quoted(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }
}
